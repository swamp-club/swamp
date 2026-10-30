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
// A search answered from the output summaries (swamp-club#4145) must return
// exactly what reading every record returns: the same runs in the same order,
// whatever saves, deletes, retention passes, damage to the index, and records
// written by other writers came before it.

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import fc from "fast-check";
import { createDefinitionId } from "../src/domain/definitions/definition.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../src/domain/models/access/server_token_model.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  type OutputSummary,
  outputSummaryOf,
  outputSummaryToData,
} from "../src/domain/models/output_summary.ts";
import { OUTPUT_SUMMARIES_DIR } from "../src/infrastructure/persistence/output_summary_index.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
// The global output scans walk the registered types.
import "../src/domain/models/models.ts";

const TYPES = [ModelType.create("command/shell"), SERVER_TOKEN_MODEL_TYPE];
const UNREGISTERED = ModelType.create("acme/not-registered");
const DEFINITIONS = Array.from({ length: 3 }, () => crypto.randomUUID());
const METHODS = ["a-method", "b-method"];
const BASE_MS = Date.UTC(2026, 0, 1, 23, 59, 59);
const PROVENANCE = {
  definitionHash: "h",
  modelVersion: "1",
  triggeredBy: "workflow" as const,
  workflowId: "w",
  stepName: "s",
};

type Status = "running" | "succeeded" | "failed";
const STATUSES: Status[] = ["running", "succeeded", "failed"];

interface Run {
  type: number;
  definition: number;
  method: number;
  /** Few distinct values across a day boundary, so ties and shards recur. */
  offset: number;
  status: Status;
}

const run: fc.Arbitrary<Run> = fc.record({
  type: fc.nat(TYPES.length - 1),
  definition: fc.nat(DEFINITIONS.length - 1),
  method: fc.nat(METHODS.length - 1),
  offset: fc.nat(6).map((step) => step * 500),
  status: fc.constantFrom(...STATUSES),
});

type Op =
  | {
    kind: "save" | "writeRecord" | "writeUnnamed" | "writeUnregistered";
    run: Run;
  }
  | { kind: "writeMislabelled"; run: Run }
  | { kind: "delete" | "finish"; pick: number }
  | { kind: "tearIndex" | "removeIndex" | "duplicateRows" | "search" }
  | { kind: "retention"; offset: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({ kind: fc.constant<"save">("save"), run }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom<
        "writeRecord" | "writeUnnamed" | "writeUnregistered"
      >(
        "writeRecord",
        "writeUnnamed",
        "writeUnregistered",
      ),
      run,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant<"writeMislabelled">("writeMislabelled"),
      run,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom<"delete" | "finish">("delete", "finish"),
      pick: fc.nat(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constantFrom<
        "tearIndex" | "removeIndex" | "duplicateRows" | "search"
      >(
        "tearIndex",
        "removeIndex",
        "duplicateRows",
        "search",
      ),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant<"retention">("retention"),
      offset: fc.nat(3000),
    }),
  },
);

function outputOf(spec: Run): ModelOutput {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(DEFINITIONS[spec.definition]),
    methodName: METHODS[spec.method],
    status: "running",
    startedAt: new Date(BASE_MS + spec.offset),
    provenance: PROVENANCE,
  });
  if (spec.status === "succeeded") output.markSucceeded();
  if (spec.status === "failed") output.markFailed({ message: "boom" });
  return output;
}

function yamlOf(output: ModelOutput): string {
  return stringifyYaml(JSON.parse(JSON.stringify(output.toData())));
}

async function writeAt(path: string, text: string): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, text);
}

/** Every shard of the checkout at `dir`. */
async function shards(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string) => {
    try {
      for await (const entry of Deno.readDir(at)) {
        const path = join(at, entry.name);
        if (entry.isDirectory) await walk(path);
        else found.push(path);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  await walk(swampPath(dir, OUTPUT_SUMMARIES_DIR));
  return found.toSorted();
}

/** What a search reports of a run, without what only a record's read has. */
function reported(summary: OutputSummary): unknown {
  return JSON.parse(JSON.stringify(outputSummaryToData(summary)));
}

/** Every record read directly, as the search would without the summaries. */
async function truth(repo: YamlOutputRepository): Promise<
  { type: string; method: string; run: unknown }[]
> {
  return (await repo.findAllGlobal()).map(({ output, type, method }) => ({
    type: type.normalized,
    method,
    run: reported(outputSummaryOf(output)),
  }));
}

async function assertSearchesMatch(
  repo: YamlOutputRepository,
  mislabelled: ReadonlySet<string>,
): Promise<void> {
  const expected = await truth(repo);
  const shape = (
    found: { output: OutputSummary; type: ModelType; method: string }[],
  ) =>
    found.map(({ output, type, method }) => ({
      type: type.normalized,
      method,
      run: reported(output),
    }));

  assertEquals(shape(await repo.findAllGlobalSummaries()), expected);

  // A cutoff inside the window also keeps the records it should.
  const cutoffMs = BASE_MS + 1000;
  assertEquals(
    shape(await repo.findAllGlobalSince(new Date(cutoffMs))),
    expected.filter((found) =>
      new Date((found.run as { startedAt: string }).startedAt).getTime() >=
        cutoffMs
    ),
  );

  // Newest first, every read returns each of them.
  const newest = await repo.findGlobalNewestFirst({});
  const read: OutputSummary[] = [];
  while (true) {
    const batch = await newest.next(3);
    if (batch.length === 0) break;
    for (const { output } of batch) read.push(output);
  }
  const unsorted = (runs: unknown[]) =>
    runs.map((found) => JSON.stringify(found)).toSorted();
  assertEquals(
    unsorted(read.map(reported)),
    unsorted(expected.map(({ run }) => run)),
  );

  for (const definition of DEFINITIONS) {
    for (const type of TYPES) {
      const history = await repo.findHistoryByDefinition(
        type,
        createDefinitionId(definition),
      );
      assertEquals(
        history.map(reported),
        expected
          .filter((found) =>
            found.type === type.normalized &&
            (found.run as { definitionId: string }).definitionId ===
              definition &&
            // A definition's history skips a file named for another.
            !mislabelled.has((found.run as { id: string }).id)
          )
          .map(({ run }) => run),
      );
    }
  }
}

async function apply(
  repo: YamlOutputRepository,
  dir: string,
  op: Op,
  saved: { type: ModelType; method: string; output: ModelOutput }[],
  mislabelled: Set<string>,
  named: Set<string>,
): Promise<void> {
  // Two runs of a method named for the same millisecond replace each other's
  // record, and a finished row can outlive that: the one case the summaries do
  // not cover (design/enablers/output-summary-index.md). A name is used once.
  const firstUse = (path: string): boolean => {
    if (named.has(path)) return false;
    named.add(path);
    return true;
  };
  switch (op.kind) {
    case "save": {
      const type = TYPES[op.run.type];
      const method = METHODS[op.run.method];
      const output = outputOf(op.run);
      if (!firstUse(repo.getPath(type, method, output))) return;
      await repo.save(type, method, output);
      saved.push({ type, method, output });
      return;
    }
    case "writeRecord": {
      const type = TYPES[op.run.type];
      const method = METHODS[op.run.method];
      const output = outputOf(op.run);
      if (!firstUse(repo.getPath(type, method, output))) return;
      await writeAt(repo.getPath(type, method, output), yamlOf(output));
      saved.push({ type, method, output });
      return;
    }
    case "writeUnnamed": {
      const output = outputOf(op.run);
      const path = repo.getPath(
        TYPES[op.run.type],
        METHODS[op.run.method],
        output,
      );
      await writeAt(
        join(dirname(path), `renamed-${crypto.randomUUID()}.yaml`),
        yamlOf(output),
      );
      return;
    }
    case "writeUnregistered": {
      const output = outputOf(op.run);
      await writeAt(
        repo.getPath(UNREGISTERED, METHODS[op.run.method], output),
        yamlOf(output),
      );
      return;
    }
    case "writeMislabelled": {
      // A record named for a definition and method it does not declare.
      const output = outputOf(op.run);
      const name = `${crypto.randomUUID()}-2026-01-02T00-00-00-000Z.yaml`;
      const path = repo.getPath(TYPES[op.run.type], "other-method", output);
      mislabelled.add(output.id);
      await writeAt(join(dirname(path), name), yamlOf(output));
      return;
    }
    case "finish": {
      if (saved.length === 0) return;
      const found = saved[op.pick % saved.length];
      if (found.output.status !== "running") return;
      found.output.markSucceeded();
      await writeAt(
        repo.getPath(found.type, found.method, found.output),
        yamlOf(found.output),
      );
      return;
    }
    case "delete": {
      if (saved.length === 0) return;
      const [found] = saved.splice(op.pick % saved.length, 1);
      await repo.delete(found.type, found.method, found.output.id);
      return;
    }
    case "tearIndex": {
      for (const shard of await shards(dir)) {
        const text = await Deno.readTextFile(shard);
        await Deno.writeTextFile(shard, text.slice(0, text.length - 7));
      }
      return;
    }
    case "duplicateRows": {
      for (const shard of await shards(dir)) {
        const text = await Deno.readTextFile(shard);
        await Deno.writeTextFile(shard, text + text);
      }
      return;
    }
    case "removeIndex": {
      await Deno.remove(swampPath(dir, OUTPUT_SUMMARIES_DIR), {
        recursive: true,
      }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      return;
    }
    case "retention": {
      // Each record's mtime is its start, so the cutoff chooses by start.
      const cutoff = new Date(BASE_MS + op.offset);
      for (const { type, method, output } of saved) {
        const path = repo.getPath(type, method, output);
        await Deno.utime(path, output.startedAt, output.startedAt).catch(
          (error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          },
        );
      }
      await repo.deleteOlderThan(cutoff);
      return;
    }
    case "search": {
      await repo.findAllGlobalSummaries();
      return;
    }
  }
}

Deno.test("output summaries: searches return what reading every record returns, whatever came before them", async () => {
  const root = await Deno.makeTempDir({ prefix: "swamp-output-summary-" });
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(op, { maxLength: 30, size: "max" }),
        async (ops) => {
          const dir = await Deno.makeTempDir({ dir: root });
          try {
            const repo = new YamlOutputRepository(dir);
            const saved: {
              type: ModelType;
              method: string;
              output: ModelOutput;
            }[] = [];
            const mislabelled = new Set<string>();
            const named = new Set<string>();
            for (const next of ops) {
              await apply(repo, dir, next, saved, mislabelled, named);
              await assertSearchesMatch(repo, mislabelled);
            }
            // Twice: the first may fill rows the second answers from.
            await assertSearchesMatch(repo, mislabelled);
          } finally {
            if (Deno.build.os === "windows") {
              // Best-effort: EBUSY can fire when V8 hasn't GC'd native
              // handles yet. Temp dir is ephemeral, OS reclaims.
              await Deno.remove(dir, { recursive: true }).catch(() => {});
            } else {
              await Deno.remove(dir, { recursive: true });
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(root, { recursive: true });
    }
  }
});
