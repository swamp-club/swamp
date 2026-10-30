// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.
// The output summaries answer history reads without opening records
// (swamp-club#4145). These wire the real repository to real files: what a read
// opens once the index is warm, and that a row never outlives what it stands
// for.

import { assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { createDefinitionId } from "../src/domain/definitions/definition.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  OUTPUT_SUMMARIES_DIR,
  removeStaleOutputSummaries,
} from "../src/infrastructure/persistence/output_summary_index.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  findSpan,
  withObservedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  observeDiagnosticPhase,
  withDiagnosticArea,
} from "../src/domain/diagnostics/diagnostic_phase.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";
// The global output scans walk the registered types.
import "../src/domain/models/models.ts";

const TYPE = ModelType.create("command/shell");
const STARTED = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
const PROVENANCE = {
  definitionHash: "h",
  modelVersion: "1",
  triggeredBy: "manual" as const,
};

async function withRepo(
  fn: (repo: YamlOutputRepository, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-output-summary-" });
  try {
    await fn(new YamlOutputRepository(dir), dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function running(startedAt = STARTED): ModelOutput {
  return ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "run",
    status: "running",
    startedAt,
    provenance: PROVENANCE,
  });
}

/** Saves `output` finished, as a method run does. */
async function saveFinished(
  repo: YamlOutputRepository,
  output = running(),
): Promise<ModelOutput> {
  output.markSucceeded();
  await repo.save(TYPE, "run", output);
  return output;
}

/** Writes `output`'s record as another checkout's write or a pull would. */
async function writeRecord(
  repo: YamlOutputRepository,
  output: ModelOutput,
): Promise<void> {
  const path = repo.getPath(TYPE, "run", output);
  await ensureDir(dirname(path));
  await Deno.writeTextFile(
    path,
    stringifyYaml(JSON.parse(JSON.stringify(output.toData()))),
  );
}

/** Runs `fn`, returning how many output records it opened. */
async function countRecordReads<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; reads: number }> {
  const readTextFile = Deno.readTextFile;
  let reads = 0;
  (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile = (
    path,
    options,
  ) => {
    if (String(path).endsWith(".yaml")) reads++;
    return readTextFile(path, options);
  };
  try {
    return { result: await fn(), reads };
  } finally {
    (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
      readTextFile;
  }
}

async function allNewestFirst(repo: YamlOutputRepository): Promise<string[]> {
  const read = await repo.findGlobalNewestFirst({});
  const ids: string[] = [];
  while (true) {
    const batch = await read.next(2);
    if (batch.length === 0) return ids;
    for (const { output } of batch) ids.push(output.id);
  }
}

Deno.test("output summaries: every history read of saved outputs opens no record", async () => {
  await withRepo(async (repo) => {
    const outputs: ModelOutput[] = [];
    for (let i = 0; i < 5; i++) {
      outputs.push(
        await saveFinished(
          repo,
          running(new Date(STARTED.getTime() + i * 26 * 60 * 60 * 1000)),
        ),
      );
    }
    const newestFirst = outputs.map((output) => output.id).reverse();
    const cutoff = new Date(STARTED.getTime() - 1);
    const sorted = (ids: string[]) => ids.toSorted();
    const expected = sorted(newestFirst);

    const since = await countRecordReads(() => repo.findAllGlobalSince(cutoff));
    assertEquals(since.reads, 0);
    assertEquals(sorted(since.result.map((r) => r.output.id)), expected);

    const all = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(all.reads, 0);
    assertEquals(sorted(all.result.map((r) => r.output.id)), expected);

    const newest = await countRecordReads(() => allNewestFirst(repo));
    assertEquals(newest.reads, 0);
    assertEquals(newest.result, newestFirst);

    const history = await countRecordReads(() =>
      repo.findHistoryByDefinition(
        TYPE,
        createDefinitionId(
          outputs[0].definitionId,
        ),
      )
    );
    assertEquals(history.reads, 0);
    assertEquals(history.result.map((o) => o.id), [outputs[0].id]);
  });
});

Deno.test("output summaries: a record written by another writer is read once, then answered from its row", async () => {
  await withRepo(async (repo) => {
    const output = running();
    output.markSucceeded();
    await writeRecord(repo, output);

    const first = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(first.reads, 1);
    assertEquals(first.result.map((r) => r.output.id), [output.id]);

    const second = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(second.reads, 0);
    assertEquals(second.result.map((r) => r.output.id), [output.id]);
  });
});

Deno.test("output summaries: a running output is read from its record every time, so its finish is seen however it was written", async () => {
  await withRepo(async (repo) => {
    const output = running();
    await repo.save(TYPE, "run", output);

    const before = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(before.reads, 1);
    assertEquals(before.result[0].output.status, "running");

    output.markSucceeded();
    await writeRecord(repo, output);
    const after = await repo.findAllGlobalSummaries();
    assertEquals(after[0].output.status, "succeeded");
    assertEquals(after[0].output.durationMs, output.durationMs);
  });
});

Deno.test("output summaries: a deleted record's row is not returned", async () => {
  await withRepo(async (repo) => {
    const kept = await saveFinished(repo);
    const deleted = await saveFinished(
      repo,
      running(new Date(STARTED.getTime() + 1)),
    );
    await repo.delete(TYPE, "run", deleted.id);

    const found = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(found.reads, 0);
    assertEquals(found.result.map((r) => r.output.id), [kept.id]);
  });
});

Deno.test("output summaries: a torn or missing shard costs a read of its records and heals", async () => {
  await withRepo(async (repo, dir) => {
    const output = await saveFinished(repo);
    const shard = await onlyShard(dir);
    await Deno.writeTextFile(shard, `{"id":"to`);

    const torn = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(torn.reads, 1);
    assertEquals(torn.result.map((r) => r.output.id), [output.id]);

    await Deno.remove(shard);
    const missing = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(missing.reads, 1);

    const healed = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(healed.reads, 0);
    assertEquals(healed.result.map((r) => r.output.id), [output.id]);
  });
});

Deno.test("output summaries: a recovery that puts back an older record clears the rows that outlived it", async () => {
  await withRepo(async (repo, dir) => {
    const output = await saveFinished(repo);
    const committed = ModelOutput.create({
      id: output.id,
      definitionId: createDefinitionId(output.definitionId),
      methodName: "run",
      status: "running",
      startedAt: output.startedAt,
      provenance: PROVENANCE,
    });
    await writeRecord(repo, committed);

    await removeStaleOutputSummaries(dir);

    const found = await repo.findAllGlobalSummaries();
    assertEquals(found[0].output.status, "running");
  });
});

Deno.test("output summaries: a record put back with no clear after it answers from itself, whatever left its row behind", async () => {
  await withRepo(async (repo) => {
    const output = await saveFinished(repo);
    await writeRecord(
      repo,
      ModelOutput.create({
        id: output.id,
        definitionId: createDefinitionId(output.definitionId),
        methodName: "run",
        status: "running",
        startedAt: output.startedAt,
        provenance: PROVENANCE,
      }),
    );
    const found = await repo.findAllGlobalSummaries();
    assertEquals(found[0].output.status, "running");
  });
});

const DAMAGE: ReadonlyArray<[string, string]> = [
  ["garbage", "{ not: [yaml"],
  ["empty", ""],
  ["schema-failing", "id: not-a-record\n"],
];

for (const [kind, content] of DAMAGE) {
  Deno.test(`output summaries: a finished record turned ${kind} is left out of every read, as reading every record does, and a repair brings it back`, async () => {
    await withRepo(async (repo) => {
      const kept = await saveFinished(repo);
      const damaged = await saveFinished(
        repo,
        running(new Date(STARTED.getTime() + 1)),
      );
      const path = repo.getPath(TYPE, "run", damaged);
      const intact = await Deno.readTextFile(path);
      await Deno.writeTextFile(path, content);

      const cutoff = new Date(STARTED.getTime() - 1);
      const expected = [kept.id];
      assertEquals(
        (await repo.findAllGlobal()).map((r) => r.output.id),
        expected,
      );
      assertEquals(
        (await repo.findAllGlobalSummaries()).map((r) => r.output.id),
        expected,
      );
      assertEquals(
        (await repo.findAllGlobalSince(cutoff)).map((r) => r.output.id),
        expected,
      );
      assertEquals(await allNewestFirst(repo), expected);
      assertEquals(
        (await repo.findHistoryByDefinition(
          TYPE,
          createDefinitionId(damaged.definitionId),
        )).length,
        0,
      );

      await Deno.writeTextFile(path, intact);
      const repaired = await countRecordReads(() =>
        repo.findAllGlobalSummaries()
      );
      assertEquals(repaired.reads, 1);
      assertEquals(repaired.result.length, 2);
      const healed = await countRecordReads(() =>
        repo.findAllGlobalSummaries()
      );
      assertEquals(healed.reads, 0);
    });
  });
}

Deno.test("output summaries: a record whose stat moved with the same content is read once, then answered from its new row", async () => {
  await withRepo(async (repo) => {
    const output = await saveFinished(repo);
    const moved = new Date(STARTED.getTime() + 1000);
    await Deno.utime(repo.getPath(TYPE, "run", output), moved, moved);

    const first = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(first.reads, 1);
    assertEquals(first.result.map((r) => r.output.id), [output.id]);
    const second = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(second.reads, 0);
  });
});

Deno.test("output summaries: readers racing on a cold index leave a shard the next read rewrites without their duplicates", async () => {
  await withRepo(async (_repo, dir) => {
    const writer = new YamlOutputRepository(dir);
    const total = 40;
    for (let i = 0; i < total; i++) {
      const output = running(new Date(STARTED.getTime() + i));
      output.markSucceeded();
      await writeRecord(writer, output);
    }

    // Separate repositories, as separate processes are: they share no scan.
    await Promise.all(
      Array.from(
        { length: 8 },
        () => new YamlOutputRepository(dir).findAllGlobalSummaries(),
      ),
    );

    const after = await countRecordReads(() => writer.findAllGlobalSummaries());
    assertEquals(after.reads, 0);
    assertEquals(after.result.length, total);
    const lines = (await Deno.readTextFile(await onlyShard(dir))).trim()
      .split("\n").length;
    assertEquals(lines < 2 * total, true, `${lines} lines for ${total} runs`);
    // And what it left still answers.
    const again = await countRecordReads(() => writer.findAllGlobalSummaries());
    assertEquals(again.reads, 0);
  });
});

Deno.test("output summaries: a read that held records while the summaries were cleared does not add them back", async () => {
  await withRepo(async (repo, dir) => {
    const output = running();
    output.markSucceeded();
    await writeRecord(repo, output);

    const readTextFile = Deno.readTextFile;
    let cleared = false;
    (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile = async (
      path,
      options,
    ) => {
      const text = await readTextFile(path, options);
      if (!cleared && String(path).endsWith(".yaml")) {
        cleared = true;
        await removeStaleOutputSummaries(dir);
      }
      return text;
    };
    try {
      await repo.findAllGlobalSummaries();
    } finally {
      (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
        readTextFile;
    }
    assertEquals(cleared, true);

    // No row was added, so the next read goes back to the record, and heals.
    const next = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(next.reads, 1);
    const healed = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(healed.reads, 0);
  });
});

Deno.test("output summaries: a cancelled scan on a cold index keeps the batches it finished", async () => {
  await withRepo(async (repo) => {
    // Past one backfill batch, so the first is finished when the abort lands.
    const total = 1030;
    for (let i = 0; i < total; i++) {
      const output = running(new Date(STARTED.getTime() + i));
      output.markSucceeded();
      await writeRecord(repo, output);
    }

    const controller = new AbortController();
    const readTextFile = Deno.readTextFile;
    let reads = 0;
    (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile = (
      path,
      options,
    ) => {
      if (String(path).endsWith(".yaml") && ++reads > 1024) {
        controller.abort();
      }
      return readTextFile(path, options);
    };
    try {
      await assertRejects(() => repo.findAllGlobalSummaries(controller.signal));
    } finally {
      (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
        readTextFile;
    }

    const next = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(next.reads, total - 1024);
    assertEquals(next.result.length, total);
  });
});

Deno.test("output summaries: a few files of a large shard read their records, and add no rows", async () => {
  await withRepo(async (repo, dir) => {
    const wanted = await saveFinished(repo);
    for (let i = 1; i <= 100; i++) {
      await saveFinished(repo, running(new Date(STARTED.getTime() + i)));
    }
    const shard = await onlyShard(dir);
    const before = await Deno.readTextFile(shard);

    const history = await countRecordReads(() =>
      repo.findHistoryByDefinition(
        TYPE,
        createDefinitionId(wanted.definitionId),
      )
    );
    assertEquals(history.reads, 1);
    assertEquals(history.result.map((o) => o.id), [wanted.id]);
    assertEquals(await Deno.readTextFile(shard), before);

    // The whole shard is worth opening.
    const all = await countRecordReads(() => repo.findAllGlobalSummaries());
    assertEquals(all.reads, 0);
    assertEquals(all.result.length, 101);
  });
});

Deno.test("output summaries: a newest-first read does not answer from shards it opened before a clear", async () => {
  await withRepo(async (repo, dir) => {
    const older = await saveFinished(repo);
    await saveFinished(repo, running(new Date(STARTED.getTime() + 1)));
    const read = await repo.findGlobalNewestFirst({});
    assertEquals((await read.next(1)).length, 1);

    const rewound = ModelOutput.create({
      id: older.id,
      definitionId: createDefinitionId(older.definitionId),
      methodName: "run",
      status: "running",
      startedAt: older.startedAt,
      provenance: PROVENANCE,
    });
    await writeRecord(repo, rewound);
    await removeStaleOutputSummaries(dir);

    const [next] = await read.next(1);
    assertEquals(next.output.id, older.id);
    assertEquals(next.output.status, "running");
  });
});

Deno.test("output summaries: candidate_scan counts rows added on a cold read and used on a warm one", async () => {
  await withRepo(async (repo) => {
    const output = running();
    output.markSucceeded();
    await writeRecord(repo, output);
    const scanned = async () => {
      let attributes: Record<string, unknown> = {};
      await withObservedSpans(async (spans) => {
        await withDiagnosticArea(
          "output_search",
          () =>
            observeDiagnosticPhase(
              "candidate_scan",
              {},
              () => repo.findAllGlobalSummaries(),
            ),
        );
        attributes = findSpan(spans, "swamp.diagnostic.candidate_scan")
          .attributes;
      });
      return attributes;
    };

    const cold = await scanned();
    assertEquals(cold["swamp.diagnostic.files_read"], 1);
    assertEquals(cold["swamp.diagnostic.summary_rows_backfilled"], 1);
    assertEquals(cold["swamp.diagnostic.summary_shards_read"], 1);
    assertEquals(cold["swamp.diagnostic.summary_rows_used"], undefined);

    const warm = await scanned();
    assertEquals(warm["swamp.diagnostic.files_read"], undefined);
    assertEquals(warm["swamp.diagnostic.summary_rows_used"], 1);
    assertEquals(warm["swamp.diagnostic.summary_shards_read"], 1);
    assertEquals(warm["swamp.diagnostic.summary_rows_backfilled"], undefined);
    assertEquals(warm["swamp.diagnostic.summary_rows_outdated"], undefined);
    assertEquals(warm["swamp.diagnostic.summary_stats"], 1);
  });
});

Deno.test("output summaries: with errorMessages, a run that did not succeed reads its message from its record, without adding a row twice", async () => {
  await withRepo(async (repo, dir) => {
    const failed = running();
    failed.markFailed({ message: "boom" });
    await repo.save(TYPE, "run", failed);
    const cutoff = new Date(STARTED.getTime() - 1);

    assertEquals(
      (await repo.findAllGlobalSince(cutoff))[0].output.errorMessage,
      undefined,
    );
    const withErrors = await countRecordReads(() =>
      repo.findAllGlobalSince(cutoff, undefined, undefined, {
        errorMessages: true,
      })
    );
    assertEquals(withErrors.reads, 1);
    assertEquals(withErrors.result[0].output.errorMessage, "boom");

    const text = await Deno.readTextFile(await onlyShard(dir));
    assertEquals(text.trim().split("\n").length, 1);
    assertEquals(text.includes("boom"), false);
  });
});

Deno.test("output summaries: retention drops the rows of what it removed, and a dry run changes nothing", async () => {
  await withRepo(async (repo, dir) => {
    const removed = await saveFinished(repo);
    const kept = await saveFinished(
      repo,
      running(new Date(Date.now() + 60 * 60 * 1000)),
    );
    const shard = await shardOf(dir, removed.startedAt);
    // Run logs and records get their mtime set back so retention takes them.
    const old = new Date(STARTED.getTime() + 1000);
    await Deno.utime(repo.getPath(TYPE, "run", removed), old, old);
    const cutoff = new Date(STARTED.getTime() + 2000);

    await repo.deleteOlderThan(cutoff, { dryRun: true });
    await Deno.stat(shard);

    await repo.deleteOlderThan(cutoff);
    let gone = false;
    try {
      await Deno.stat(shard);
    } catch (error) {
      gone = error instanceof Deno.errors.NotFound;
    }
    assertEquals(gone, true);
    assertEquals(
      (await repo.findAllGlobalSummaries()).map((r) => r.output.id),
      [kept.id],
    );
  });
});

Deno.test("output summaries: the index stays outside the records it summarises, so sync and recovery never see it", async () => {
  await withRepo(async (repo, dir) => {
    await saveFinished(repo);
    const shard = await onlyShard(dir);
    assertEquals(
      shard.startsWith(swampPath(dir, OUTPUT_SUMMARIES_DIR)),
      true,
    );
    const outputsDir = swampPath(dir, "outputs");
    assertEquals(shard.startsWith(outputsDir), false);
  });
});

async function allShards(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string) => {
    for await (const entry of Deno.readDir(at)) {
      const path = join(at, entry.name);
      if (entry.isDirectory) await walk(path);
      else found.push(path);
    }
  };
  await walk(swampPath(dir, OUTPUT_SUMMARIES_DIR));
  return found;
}

async function onlyShard(dir: string): Promise<string> {
  const shards = await allShards(dir);
  assertEquals(shards.length, 1);
  return shards[0];
}

async function shardOf(dir: string, startedAt: Date): Promise<string> {
  const day = startedAt.toISOString().slice(0, 10);
  const shards = (await allShards(dir)).filter((path) => path.includes(day));
  assertEquals(shards.length, 1);
  return shards[0];
}

Deno.test("output summaries: on a v3 datastore a committed save keeps its row through the checkout's catch-up", async () => {
  await withV3RowRepos({}, async (repos) => {
    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "noop",
      status: "running",
      startedAt: STARTED,
      provenance: PROVENANCE,
    });
    output.markSucceeded();
    await runInRootUnitOfWork(
      repos.a.repoContext,
      { flush: undefined },
      () =>
        repos.a.repoContext.outputRepo.save(repos.modelType, "noop", output),
    );

    const reopened = await requireInitializedRepoUnlocked({
      repoDir: repos.repoA,
      outputMode: "json",
    });
    const read = await countRecordReads(() =>
      reopened.repoContext.outputRepo.findAllGlobalSummaries()
    );
    assertEquals(read.result.map((r) => r.output.id), [output.id]);
    assertEquals(read.reads, 0);
  });
});
