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

import { assert, assertEquals } from "@std/assert";
import { dirname, join, relative } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { type Op, putOp, tombstoneOp } from "../src/domain/datastore_v3/op.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  base64,
  modelIntent,
  modelPartition,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  READ_MODEL_STATE_FILE,
  type SqliteReadModel,
} from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import type { SpellingFolding } from "../src/infrastructure/datastore_v3/spelling_folding.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { withCapturedSpans } from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  catalogV3Path,
  commitOf,
  readCatalog,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const PARTITION = modelPartition();
const ATTR = "swamp.datastore.v3.";

// Mostly two names, so keys meet each other and the links between them; the
// rest differ from a written name by case or Unicode normalisation, or are
// non-ASCII.
const arbSegment = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("a", "l") },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      "A",
      String.fromCodePoint(0xe9),
      "e" + String.fromCodePoint(0x301),
      String.fromCodePoint(0xdf),
      "SS",
      "x.y",
      String.fromCodePoint(0xfc),
    ),
  },
);

const arbSegments = (max: number) =>
  fc.array(arbSegment, { minLength: 1, maxLength: max });

// Mostly a link l to a, so one directory has two spellings.
const arbEntry = fc.record({
  at: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(["l"], ["a", "l"]) },
    { weight: 1, arbitrary: arbSegments(2) },
  ),
  kind: fc.oneof(
    { weight: 4, arbitrary: fc.constant("inside" as const) },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "file" as const,
        "dir" as const,
        "outside" as const,
        "state" as const,
      ),
    },
  ),
  to: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(["a"], ["a", "a"]) },
    { weight: 1, arbitrary: arbSegments(2) },
  ),
});
type Entry = typeof arbEntry extends fc.Arbitrary<infer T> ? T : never;

const arbOp = fc.record({
  key: arbSegments(3),
  put: fc.boolean(),
  text: fc.constantFrom("p", "q", "r"),
});

const arbStep = fc.record({
  ops: fc.array(arbOp, { minLength: 1, maxLength: 4 }),
  catchUp: fc.boolean(),
});

const arbRun = fc.record({
  tree: fc.array(arbEntry, { maxLength: 4 }),
  steps: fc.array(arbStep, { minLength: 1, maxLength: 10 }),
  compact: fc.boolean(),
  pageSize: fc.integer({ min: 1, max: 3 }),
  pooled: fc.boolean(),
});
type Run = typeof arbRun extends fc.Arbitrary<infer T> ? T : never;

function dataPath(env: V3Env, segments: readonly string[]): string {
  return join(swampPath(env.repoDir), "data", ...segments);
}

async function ignoringClashes(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (
      !(error instanceof Deno.errors.AlreadyExists) &&
      !(error instanceof Deno.errors.NotADirectory) &&
      !(error instanceof Deno.errors.NotFound)
    ) {
      throw error;
    }
  }
}

async function plant(env: V3Env, tree: readonly Entry[]): Promise<void> {
  const outside = join(env.dir, "outside");
  await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(join(outside, "o"), "outside");
  await Deno.mkdir(join(swampPath(env.repoDir), "data"), { recursive: true });
  for (const entry of tree) {
    const path = dataPath(env, entry.at);
    await ignoringClashes(async () => {
      await Deno.mkdir(dirname(path), { recursive: true });
      if (entry.kind === "file") {
        await Deno.writeTextFile(path, "planted", { createNew: true });
      } else if (entry.kind === "dir") {
        await Deno.mkdir(path);
      } else {
        const target = entry.kind === "inside"
          ? dataPath(env, entry.to)
          : entry.kind === "outside"
          ? outside
          : env.stateDir;
        await Deno.symlink(relative(dirname(path), target), path, {
          type: "dir",
        });
      }
    });
  }
}

/** the tree as lstat sees it, links unfollowed */
async function snapshot(env: V3Env): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  const visit = async (dir: string, rel: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(dir, entry.name);
      const at = `${rel}/${entry.name}`;
      const info = await Deno.lstat(path);
      if (info.isSymlink) seen[at] = `link:${await Deno.readLink(path)}`;
      else if (info.isDirectory) {
        seen[at] = "dir";
        await visit(path, at);
      } else seen[at] = `file:${await Deno.readTextFile(path)}`;
    }
  };
  await visit(join(swampPath(env.repoDir), "data"), "data");
  await visit(join(env.dir, "outside"), "outside");
  return seen;
}

// Measured, or about the paths' facts themselves, so it differs by design.
const UNCOMPARED = /(_ms$)|(\.path_)|(\.lookahead_)/;

function verdictAttributes(
  spans: readonly { name: string; attributes: Record<string, unknown> }[],
): string[] {
  return spans
    .filter((span) => span.name.startsWith("swamp.datastore.v3"))
    .map((span) =>
      JSON.stringify([
        span.name,
        Object.entries(span.attributes)
          .filter(([key]) => !UNCOMPARED.test(key))
          .sort(([a], [b]) => a < b ? -1 : 1),
      ])
    )
    .sort();
}

// Stat results of the files written, which differ between two trees.
const VOLATILE_COLUMN = /^(ino|dev|mtime|ctime|mtime_ms|ctime_ms|boot)$/;

function stateDump(env: V3Env): Record<string, unknown[]> {
  const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE), {
    readOnly: true,
  });
  try {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);
    const dump: Record<string, unknown[]> = {};
    for (const table of tables) {
      dump[table] = (db.prepare(`SELECT * FROM "${table}"`).all() as Record<
        string,
        unknown
      >[])
        .map((row) =>
          JSON.stringify(
            Object.entries(row).filter(([column]) =>
              !VOLATILE_COLUMN.test(column)
            ),
          )
        )
        .sort();
    }
    return dump;
  } finally {
    db.close();
  }
}

async function opOf(op: Run["steps"][number]["ops"][number]): Promise<Op> {
  const key = RecordKey.create(["data", ...op.key].join("/"));
  const intent = (kind: "data.save" | "data.delete") =>
    modelIntent({ kind, name: "n", version: 1 });
  return op.put
    ? await putOp({ intent: intent("data.save"), key, inline: base64(op.text) })
    : tombstoneOp({ intent: intent("data.delete"), key });
}

/** what one side saw after each catch-up */
async function play(
  env: V3Env,
  run: Run,
  folding: SpellingFolding,
  facts: boolean,
  probes: { stats: number },
): Promise<unknown[]> {
  // A pooled write and a probe of another spelling of its directory, through a
  // link inside the root, race; written one at a time they cannot.
  // Unpooled, l is always a link to a, so keys reach each other's files.
  await plant(
    env,
    run.pooled
      ? run.tree.filter((entry) => entry.kind !== "inside")
      : [{ at: ["l"], kind: "inside", to: ["a"] }, ...run.tree],
  );
  const seen: unknown[] = [];
  const readModel: SqliteReadModel = env.openReadModel({
    pageSize: run.pageSize,
    ...(run.pooled ? {} : { pooledWrites: 1 }),
    spellingFolding: folding,
    pathFacts: facts,
    bootIdentity: () => Promise.resolve("boot-1"),
  });
  try {
    let seq = 0;
    let compacted = !run.compact;
    const steps = [...run.steps, { ops: [], catchUp: true }];
    for (const step of steps) {
      if (step.ops.length > 0) {
        const last = new Map<string, Op>();
        for (const op of step.ops) last.set(op.key.join("/"), await opOf(op));
        await env.store.append(
          commitOf({
            seq: ++seq,
            partition: PARTITION,
            namespace: "",
            ops: [...last.values()],
          }),
        );
      }
      if (!step.catchUp) continue;
      if (!compacted && seq > 0) {
        compacted = true;
        await env.store.compactHistory(seq);
      }
      let outcome = "ok";
      let spans: string[] = [];
      await withCapturedSpans(async (captured) => {
        try {
          await readModel.catchUp(AbortSignal.timeout(30_000));
        } catch (error) {
          outcome = `${(error as Error).name}: ${
            (error as Error).message.replaceAll(env.dir, "<env>")
          }`;
        }
        for (const span of captured) {
          probes.stats += Number(span.attributes[`${ATTR}path_stats`] ?? 0);
        }
        spans = verdictAttributes(
          captured.map((span) => ({
            name: span.name,
            attributes: span.attributes as Record<string, unknown>,
          })),
        );
      });
      const index = outcome === "ok"
        ? (await readModel.liveRecords("", PARTITION)).map((record) => [
          record.key.toString(),
          record.sha256,
        ])
        : [];
      seen.push({
        outcome,
        spans,
        tree: await snapshot(env),
        index,
        catalog: readCatalog(catalogV3Path(env)),
        state: stateDump(env),
      });
    }
  } finally {
    await readModel.close();
  }
  return seen;
}

for (const folding of ["off", "canonical", "list"] as const) {
  Deno.test({
    name:
      `read model path facts: with ${folding} folding, a read model with the facts agrees with one without on every verdict, skip, alias, the tree and the state (swamp-club#5136)`,
    // symlinks need a privilege on Windows
    ignore: Deno.build.os === "windows",
    fn: async () => {
      const coverage = { statsSaved: 0, aliased: 0, refused: 0 };
      await fc.assert(
        fc.asyncProperty(arbRun, async (run) => {
          let withFacts: unknown[] = [];
          let without: unknown[] = [];
          const on = { stats: 0 };
          const off = { stats: 0 };
          await withV3Env(async (env) => {
            withFacts = await play(env, run, folding, true, on);
          });
          await withV3Env(async (env) => {
            without = await play(env, run, folding, false, off);
          });
          assertEquals(withFacts, without);
          coverage.statsSaved += off.stats - on.stats;
          const seen = JSON.stringify(without);
          if (seen.includes(`${ATTR}aliased_skipped`)) coverage.aliased++;
          if (seen.includes(`"outcome":"Path`)) coverage.refused++;
        }),
        { numRuns: 100 },
      );
      console.log(`path facts coverage: ${JSON.stringify(coverage)}`);
      assert(coverage.statsSaved > 0, JSON.stringify(coverage));
      // only canonical folding reads a link's target as another key's spelling
      if (folding === "canonical") {
        assert(coverage.aliased > 0, JSON.stringify(coverage));
      }
    },
  });
}
