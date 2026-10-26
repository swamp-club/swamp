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

/**
 * The v3 read model's net replay (swamp-club#3803): a catch-up from an
 * empty checkout writes only the content still on disk at the end of the
 * feed. Over random histories it must end exactly where a full replay of the
 * same feed ends: the same files, live records, catalog rows, file ownership
 * and unreadable records. The histories mix keys that are each other's path
 * prefix, a key two partitions write, deletes and overwrites, readable and
 * unreadable chunked content (the final version's chunk missing, or a
 * replaced version's), a checkout that already holds a file under a key's
 * directory, and a net catch-up that crashes at a page's barrier and is
 * resumed by the next one.
 *
 * With a compacted history (swamp-club#3916) the catch-up loads the base
 * first, and a net one leaves off disk each base file the tail after it
 * replaces or removes. A crash then lands at the base load's barrier, after
 * its files and before the state moves, or at a page of the tail after it.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import { putOp, tombstoneOp } from "../src/domain/datastore_v3/op.ts";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  deleteVersion,
  modelPartition,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { DurableWriteBatch } from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";
import {
  type ReadableSpan,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import { READ_MODEL_STATE_FILE } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import type { SqliteReadModel } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import {
  base64Of,
  catalogV3Path,
  commitOf,
  readCatalog,
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

/**
 * Config keys: the second lies under the first, and the last is the third in
 * another case; the rest stand alone.
 */
const KEYS = [
  "config/models/p/a.yaml",
  "config/models/p/a.yaml/b.yaml",
  "config/models/q.yaml",
  "config/workflows/r.yaml",
  // The third key spelt in another case: one file on macOS and Windows.
  "config/models/Q.yaml",
] as const;

const NAMES = ["alpha", "beta"] as const;
type Name = typeof NAMES[number];

/** Over the inline limit, so it is stored as chunks. */
const BLOB_BYTES = 9_000;

type Content =
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "blob"; readonly fill: number }
  | { readonly kind: "missing" };

type OpSpec =
  | { readonly key: number; readonly content: Content }
  | { readonly key: number; readonly tombstone: true };

type CommitSpec =
  | { readonly kind: "config"; readonly name: Name; readonly ops: OpSpec[] }
  | {
    readonly kind: "data";
    readonly name: "a" | "b";
    readonly version: number;
    readonly remove: boolean;
  };

const arbContent: fc.Arbitrary<Content> = fc.oneof(
  fc.record({
    kind: fc.constant("inline" as const),
    text: fc.constantFrom("x", "y", "z"),
  }),
  fc.record({
    kind: fc.constant("blob" as const),
    fill: fc.integer({ min: 1, max: 3 }),
  }),
  fc.constant({ kind: "missing" as const }),
);

const arbOp: fc.Arbitrary<OpSpec> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      key: fc.integer({ min: 0, max: KEYS.length - 1 }),
      content: arbContent,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      key: fc.integer({ min: 0, max: KEYS.length - 1 }),
      tombstone: fc.constant(true as const),
    }),
  },
);

const arbCommit: fc.Arbitrary<CommitSpec> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("config" as const),
      name: fc.constantFrom(...NAMES),
      ops: fc.array(arbOp, { minLength: 1, maxLength: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("data" as const),
      name: fc.constantFrom("a" as const, "b" as const),
      version: fc.integer({ min: 1, max: 3 }),
      remove: fc.boolean(),
    }),
  },
);

function partitionFor(name: Name): PartitionKey {
  return partitionOf({ kind: "config", definitionKind: "model", name });
}

async function buildConfigOp(
  env: V3Env,
  name: Name,
  spec: OpSpec,
  ordinal: number,
): Promise<Op> {
  const key = RecordKey.create(KEYS[spec.key]);
  const definition = { kind: "model" as const, name };
  if ("tombstone" in spec) {
    return tombstoneOp({
      intent: { kind: "definition.delete", definition },
      key,
    });
  }
  const intent = { kind: "definition.edit" as const, definition };
  const content = spec.content;
  if (content.kind === "inline") {
    return await putOp({
      intent,
      key,
      inline: base64Of(new TextEncoder().encode(content.text)),
    });
  }
  if (content.kind === "blob") {
    const blob = await env.chunkStore.write(
      SOLO_NAMESPACE,
      new Uint8Array(BLOB_BYTES).fill(content.fill),
      AbortSignal.timeout(30_000),
    );
    return await putOp({ intent, key, blob });
  }
  // A chunk the storage never held: its content cannot be read. Named by
  // the op's place in the history, so both replays see the same one.
  const sha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`missing-${ordinal}`),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return await putOp({
    intent,
    key,
    blob: BlobRef.create({ sha256, size: BLOB_BYTES }),
  });
}

/** Appends `history` to the store; a commit the store refuses is dropped. */
async function append(
  env: V3Env,
  history: readonly CommitSpec[],
): Promise<number> {
  const seqs = new Map<string, number>();
  let landed = 0;
  let ordinal = 0;
  for (const spec of history) {
    const partition = spec.kind === "config"
      ? partitionFor(spec.name)
      : modelPartition();
    const id = partition.toString();
    const seq = (seqs.get(id) ?? 0) + 1;
    const ops: Op[] = [];
    if (spec.kind === "config") {
      for (const op of spec.ops) {
        ops.push(await buildConfigOp(env, spec.name, op, ordinal++));
      }
    } else if (spec.remove) {
      ops.push(deleteVersion(spec.name, spec.version));
    } else {
      ops.push(
        await savePut(spec.name, spec.version, `${spec.name}${spec.version}`),
        versionOp(spec.name, spec.version),
      );
    }
    try {
      await env.store.append(commitOf({ seq, partition, namespace: "", ops }));
    } catch (error) {
      if (!(error instanceof CommitRejectedError)) throw error;
      continue;
    }
    seqs.set(id, seq);
    landed++;
  }
  return landed;
}

/** A batch that fails its barrier on page `page` (from 1), before syncing. */
class CrashAtPage extends DurableWriteBatch {
  constructor(readonly control: { pages: number; at: number | undefined }) {
    super({ sync: false });
    control.pages++;
  }
  override async barrier(): Promise<void> {
    if (this.control.pages === this.control.at) {
      this.control.at = undefined;
      throw new Error("injected crash before the barrier");
    }
    await super.barrier();
  }
}

/** Rows of a read model state table, for comparison. */
function stateRows(env: V3Env, sql: string): unknown[] {
  const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE), {
    readOnly: true,
  });
  try {
    return (db.prepare(sql).all() as Record<string, unknown>[]).map((row) =>
      Object.values(row)
    );
  } finally {
    db.close();
  }
}

async function observe(
  env: V3Env,
  readModel: SqliteReadModel,
): Promise<unknown> {
  const index: Record<string, unknown> = {};
  for (const partition of [...NAMES.map(partitionFor), modelPartition()]) {
    index[partition.toString()] = (await readModel.liveRecords("", partition))
      .map((r) => [r.key.toString(), r.sha256]);
  }
  return {
    files: Object.fromEntries(await readTree(env.cacheRoot(""))),
    index,
    catalog: readCatalog(catalogV3Path(env)).rows.map((
      r,
    ) => [r.data_name, r.version, r.is_latest]),
    ownership: stateRows(
      env,
      "SELECT namespace, record_key, owner, mark, present FROM materialised_keys ORDER BY namespace, record_key",
    ),
    unreadable: stateRows(
      env,
      "SELECT namespace, record_key, partition, seq, position FROM unreadable_records ORDER BY namespace, record_key",
    ),
  };
}

interface Scenario {
  readonly history: CommitSpec[];
  readonly pageSize: number;
  /**
   * A file already under `config/` before the first catch-up, as a rebuild
   * over a checkout's files finds: at one of the keys, or beside them.
   */
  readonly stray: "none" | "key" | "beside";
  /** The first catch-up's page whose barrier crashes, if any. */
  readonly crashAt: number | undefined;
  /** The feed position history is compacted through, if any. */
  readonly compactAt: number | undefined;
}

/** What the net replays skipped, summed over a run's catch-ups. */
interface Skipped {
  writes: number;
  chunked: number;
  removals: number;
  /** Base files a load left off disk (swamp-club#3916). */
  base: number;
  /** Catch-ups that loaded a compacted base. */
  loads: number;
}

function skippedIn(spans: readonly ReadableSpan[]): Skipped {
  const sum = (name: string) =>
    spans.filter((span) => span.name === "swamp.datastore.v3.readmodel.catchup")
      .reduce(
        (total, span) =>
          total +
          ((span.attributes[`swamp.datastore.v3.${name}`] as number) ?? 0),
        0,
      );
  return {
    writes: sum("writes_skipped"),
    chunked: sum("chunked_writes_skipped"),
    removals: sum("removals_skipped"),
    base: sum("base_writes_skipped"),
    loads:
      spans.filter((span) =>
        span.name === "swamp.datastore.v3.readmodel.load_base"
      ).length,
  };
}

/** Runs `scenario` with the given replay; resolves with what it left. */
async function run(
  scenario: Scenario,
  net: boolean,
  skipped?: Skipped,
): Promise<unknown> {
  let result: unknown;
  await withCapturedSpans(async (spans) => {
    result = await runNow(scenario, net);
    if (skipped !== undefined) Object.assign(skipped, skippedIn(spans));
  });
  return result;
}

async function runNow(scenario: Scenario, net: boolean): Promise<unknown> {
  let result: unknown;
  await withV3Env(async (env) => {
    await append(env, scenario.history);
    if (scenario.compactAt !== undefined) {
      await env.store.compactHistory(scenario.compactAt);
    }
    if (scenario.stray !== "none") {
      const stray = scenario.stray === "key"
        ? join(env.cacheRoot(""), ...KEYS[2].split("/"))
        : join(env.cacheRoot(""), "config", "stray.txt");
      await Deno.mkdir(join(stray, ".."), { recursive: true });
      await Deno.writeTextFile(stray, "local");
    }
    const control = { pages: 0, at: scenario.crashAt };
    const first = env.openReadModel({
      pageSize: scenario.pageSize,
      netReplay: net,
      writeBatch: () => new CrashAtPage(control),
    });
    try {
      await first.catchUp(AbortSignal.timeout(30_000)).catch((error) => {
        if (!/injected crash/.test(String(error))) throw error;
      });
    } finally {
      await first.close();
    }
    // The next command's catch-up, as another process.
    const next = env.openReadModel({
      pageSize: scenario.pageSize,
      netReplay: net,
    });
    try {
      await next.catchUp(AbortSignal.timeout(30_000));
      result = await observe(env, next);
    } finally {
      await next.close();
    }
  });
  return result;
}

/**
 * Whether a put of unreadable content on a key that skips writes is replaced
 * later in the history by the same partition: a skipped version whose chunk
 * is missing.
 */
function replacesMissing(scenario: Scenario): boolean {
  if (scenario.stray !== "none") return false;
  const pending = new Set<string>();
  for (const commit of scenario.history) {
    if (commit.kind !== "config") continue;
    for (const op of commit.ops) {
      // Only key 3 skips writes: 0 and 1 are each other's prefix, and 2
      // and 4 differ only in case.
      if (op.key !== 3) continue;
      const id = `${commit.name}:${op.key}`;
      if (pending.has(id)) return true;
      if ("content" in op && op.content.kind === "missing") pending.add(id);
    }
  }
  return false;
}

Deno.test("read model: a net replay ends where a full replay of the same feed ends (swamp-club#3803)", async () => {
  const coverage = {
    runs: 0,
    skippedWrites: 0,
    skippedChunked: 0,
    skippedRemovals: 0,
    skippedMissing: 0,
    crashed: 0,
    unreadableEnds: 0,
    baseLoads: 0,
    baseSkipped: 0,
    baseSkippedCrashed: 0,
  };
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        history: fc.array(arbCommit, { minLength: 1, maxLength: 14 }),
        pageSize: fc.integer({ min: 1, max: 4 }),
        stray: fc.constantFrom(
          "none" as const,
          "key" as const,
          "beside" as const,
        ),
        crashAt: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
        compactAt: fc.option(fc.integer({ min: 1, max: 14 }), {
          nil: undefined,
        }),
      }),
      async (scenario) => {
        const full = await run(scenario, false);
        const skipped = {
          writes: 0,
          chunked: 0,
          removals: 0,
          base: 0,
          loads: 0,
        };
        const net = await run(scenario, true, skipped);
        assertEquals(net, full);
        coverage.runs++;
        if (skipped.writes > 0) coverage.skippedWrites++;
        if (skipped.chunked > 0) coverage.skippedChunked++;
        if (skipped.removals > 0) coverage.skippedRemovals++;
        if (replacesMissing(scenario)) coverage.skippedMissing++;
        if (scenario.crashAt !== undefined) coverage.crashed++;
        if (skipped.loads > 0) coverage.baseLoads++;
        if (skipped.base > 0) {
          coverage.baseSkipped++;
          if (scenario.crashAt !== undefined) coverage.baseSkippedCrashed++;
        }
        if ((full as { unreadable: unknown[] }).unreadable.length > 0) {
          coverage.unreadableEnds++;
        }
      },
    ),
    { numRuns: 150 },
  );
  console.error(`net replay property coverage: ${JSON.stringify(coverage)}`);
});
