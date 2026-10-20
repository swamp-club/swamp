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
 * A model-based property test of the commit outbox (swamp-club#3490): over
 * random interleavings of staging, flushing, refusals and their
 * acknowledgement, seq gaps, writers killed at any point of a commit,
 * recoveries, takeovers by another copy, compaction with pruning, the clock
 * passing the retry bound, chunk sweeps landing inside a commit, power
 * cuts (swamp-club#3506) that undo the outbox removals not yet fsynced, and
 * a unit's discard failing after a failed append, with or without its
 * abandoned mark (swamp-club#3586), the real unit, sink, outbox, commit
 * store and collector keep:
 *
 * - a commit whose failure or drop was reported never lands later; one
 *   reported as one that may land is not held to it;
 * - a commit never lands after another copy took the lease since it was
 *   prepared, unless it landed before;
 * - a commit lands only on the head it was prepared on;
 * - a workflow run record never lands after a data commit of its unit that
 *   was refused or dropped, unless the unit acknowledged it in between;
 * - no stored commit names a missing chunk.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { ChunkCollector } from "../src/domain/datastore_v3/chunk_collector.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import {
  Commit,
  type CommitWriter,
} from "../src/domain/datastore_v3/commit.ts";
import {
  COMPACTED_TXN_RETENTION_MS,
  type HeadIdentity,
  OUTBOX_RETRY_BOUND_MS,
  type OutboxKey,
} from "../src/domain/datastore_v3/commit_outbox.ts";
import {
  type CommitLogUnitOfWork,
  MayLandLaterError,
} from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import type { PartitionKey } from "../src/domain/datastore_v3/partition_key.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import {
  MemoryStorage,
  modelPartition,
  savePut,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  type CommitSink,
  createCommitLogUnitOfWork,
} from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import {
  runPartition,
  runPut,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import { recoverCommitOutbox } from "../src/infrastructure/datastore_v3/commit_outbox_recovery.ts";
import { createOutboxCommitSink } from "../src/infrastructure/datastore_v3/outbox_commit_sink.ts";
import { SqliteCommitOutbox } from "../src/infrastructure/datastore_v3/sqlite_commit_outbox.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";

/** Where a commit is faulted while a flush runs. */
type Fault =
  | "none"
  | "fail-append"
  | "kill-before-prepare"
  | "kill-after-prepare"
  | "kill-after-append"
  | "sweep-before-prepare"
  | "sweep-after-prepare"
  | "race-append"
  | "stray-commit-then-kill"
  | "sweep-before-prepare-then-kill"
  | "sweep-after-prepare-then-kill"
  | "sweep-before-append-then-kill"
  | "fail-append-and-discard"
  | "fail-append-discard-and-mark";

/** What each fault does: actions that fire once, at the first group reaching them. */
const ACTIONS: Record<Fault, readonly string[]> = {
  "none": [],
  "fail-append": ["fail-append"],
  "kill-before-prepare": ["kill-before-prepare"],
  "kill-after-prepare": ["kill-after-prepare"],
  "kill-after-append": ["kill-after-append"],
  "sweep-before-prepare": ["sweep-before-prepare"],
  "sweep-after-prepare": ["sweep-after-prepare"],
  "race-append": ["race-append"],
  "stray-commit-then-kill": ["stray-commit-then-kill"],
  // Gap 2: a sweep inside the commit, and the writer dead before its check.
  "sweep-before-prepare-then-kill": [
    "sweep-before-prepare",
    "kill-after-append",
  ],
  "sweep-after-prepare-then-kill": ["sweep-after-prepare", "kill-after-append"],
  // After the writer's second look at the sweep state: only the sweep's own
  // reference check can see the prepared entry.
  "sweep-before-append-then-kill": ["sweep-before-append", "kill-after-append"],
  // The unit's discard fails too: its abandoned mark keeps the failure from
  // landing (swamp-club#3586).
  "fail-append-and-discard": ["fail-append", "fail-discard"],
  // Neither can be written: the unit says the commit may land.
  "fail-append-discard-and-mark": [
    "fail-append",
    "fail-discard",
    "fail-abandon",
  ],
};

type Command =
  | { readonly kind: "stage"; readonly target: number; readonly big: boolean }
  | { readonly kind: "stage-run" }
  | { readonly kind: "stage-refused" }
  | { readonly kind: "checkpoint"; readonly fault: Fault }
  | { readonly kind: "commit"; readonly fault: Fault }
  | { readonly kind: "abandon" }
  | { readonly kind: "acknowledge" }
  /**
   * A new writer takes the lease and recovers. With `cutAfter`, power is cut
   * when the recovery reaches that many removals (after landing an entry it
   * has not settled, at 0), or before it raises the floor when it removed
   * fewer but some; the
   * cut keeps the first `cutKeep` removals since the last fsync, and a
   * further writer recovers.
   */
  | {
    readonly kind: "restart";
    readonly takeover: boolean;
    readonly cutAfter?: number;
    readonly cutKeep?: number;
  }
  | { readonly kind: "compact" }
  | { readonly kind: "age" }
  | { readonly kind: "sweep" }
  /**
   * Power is cut: the outbox removals since its last fsync after the first
   * `keep` are undone, and a new writer recovers.
   */
  | { readonly kind: "power-cut"; readonly keep: number };

const FAULTS: readonly Fault[] = [
  "none",
  "fail-append",
  "kill-before-prepare",
  "kill-after-prepare",
  "kill-after-append",
  "sweep-before-prepare",
  "sweep-after-prepare",
  "race-append",
  "stray-commit-then-kill",
  "sweep-before-prepare-then-kill",
  "sweep-after-prepare-then-kill",
  "sweep-before-append-then-kill",
  "fail-append-and-discard",
  "fail-append-discard-and-mark",
];

const arbCommand: fc.Arbitrary<Command> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("stage" as const),
      target: fc.integer({ min: 0, max: 1 }),
      big: fc.boolean(),
    }),
    weight: 4,
  },
  { arbitrary: fc.constant({ kind: "stage-run" as const }), weight: 2 },
  { arbitrary: fc.constant({ kind: "stage-refused" as const }), weight: 2 },
  {
    arbitrary: fc.record({
      kind: fc.constant("checkpoint" as const),
      fault: fc.constantFrom(...FAULTS),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("commit" as const),
      fault: fc.constantFrom(...FAULTS),
    }),
    weight: 2,
  },
  { arbitrary: fc.constant({ kind: "abandon" as const }), weight: 1 },
  { arbitrary: fc.constant({ kind: "acknowledge" as const }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("restart" as const),
      takeover: fc.boolean(),
      cutAfter: fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
      cutKeep: fc.integer({ min: 0, max: 2 }),
    }, { requiredKeys: ["kind", "takeover"] }),
    weight: 3,
  },
  { arbitrary: fc.constant({ kind: "compact" as const }), weight: 1 },
  { arbitrary: fc.constant({ kind: "age" as const }), weight: 2 },
  { arbitrary: fc.constant({ kind: "sweep" as const }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("power-cut" as const),
      keep: fc.integer({ min: 0, max: 3 }),
    }),
    weight: 2,
  },
);

/** The definitions staged into: few, so commits contend for partitions. */
const IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
] as const;

class Killed extends Error {}

/** What the runs exercised, across every run of the property. */
const coverage = {
  runs: 0,
  kills: 0,
  landed: 0,
  settled: 0,
  refusals: 0,
  seqGaps: 0,
  sweepDeletes: 0,
  /** Removals a power cut undid, by kind. */
  undone: { settle: 0, discard: 0 },
  /** Recoveries a power cut stopped part way. */
  recoveryCuts: 0,
  /** Units that reported their commits may land (swamp-club#3586). */
  mayLand: 0,
  drops: {} as Record<string, number>,
};

/** SQLite's `PRAGMA synchronous` value for FULL. */
const SYNCHRONOUS_FULL = 2;

type Row = Record<string, SQLInputValue>;

/** An outbox entry's rows as they were before a removal. */
interface RemovedEntry {
  readonly kind: "settle" | "discard";
  readonly entry: Row;
  readonly chunks: readonly Row[];
}

/** Puts `rows` back into `table` as they were. */
function restoreRows(db: DatabaseSync, table: string, rows: readonly Row[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${
        columns.map(() => "?").join(", ")
      })`,
    ).run(...columns.map((column) => row[column]));
  }
}

interface GroupRecord {
  readonly txnId: string;
  readonly unit: number;
  readonly run: boolean;
  /** Each prepare: its step and base. The last one is the one that counts. */
  prepares: { step: number; base: HeadIdentity }[];
  /** The step its unit reported it failed, when it was not landed then. */
  failedAt?: number;
}

/** Runs one interleaving against fresh stores; throws when an invariant breaks. */
async function runModel(commands: readonly Command[]): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-outbox-model-" });
  const store = SqliteCommitStore.open(join(dir, "commits.db"));
  const outboxPath = join(dir, "outbox.db");
  /** Removals not fsynced yet: a FULL write syncs every WAL frame before it. */
  let unsynced: RemovedEntry[] = [];
  let lastSynchronous = SYNCHRONOUS_FULL;
  const outbox = new SqliteCommitOutbox(outboxPath, {
    clock: () => new Date(now),
    onWrite: (synchronous) => {
      lastSynchronous = synchronous;
      if (synchronous === SYNCHRONOUS_FULL) unsynced = [];
    },
  });
  /** A second connection, as a power cut's view of the outbox file. */
  let disk: DatabaseSync | undefined;
  const diskDb = () => disk ??= new DatabaseSync(outboxPath);
  const storage = new MemoryStorage({ maxChunkBytes: 16 * 1024 });
  const chunkStore = new ChunkStore(storage);
  let now = Date.parse("2026-10-15T00:00:00.000Z");
  const signal = new AbortController().signal;

  let fence = 0;
  /** Steps at which another copy took the lease. */
  const takeovers: number[] = [];
  const groups = new Map<string, GroupRecord>();
  /** Per unit: steps at which it acknowledged refusals. */
  const acknowledged = new Map<number, number[]>();
  /** Per unit: steps at which one of its data commits was refused or dropped. */
  const refusedAt = new Map<number, number[]>();
  let step = 0;
  /** The fault's actions not yet fired in this flush; each fires once. */
  const actions = new Set<string>();
  const take = (action: string): boolean => actions.delete(action);
  let processId = 0;
  let writer: CommitWriter | undefined;
  let unit: CommitLogUnitOfWork | undefined;
  let unitNo = 0;
  let nextUnit = 0;
  const unitIds = new Map<string, number>();
  let stagedBlob = 0;

  const landedSeq = (txnId: string, run: boolean) =>
    store.landedSeq("", run ? runPartition() : partitionFor(txnId), txnId);
  const partitionOfTxn = new Map<string, PartitionKey>();
  const partitionFor = (txnId: string) => partitionOfTxn.get(txnId)!;

  const sweep = async () => {
    const sweeper = crypto.randomUUID();
    const report = await new ChunkCollector({
      commitStore: {
        async referencedChunks(ns, hashes, releasedSince) {
          const names = await store.referencedChunks(ns, hashes, releasedSince);
          for (const hash of await outbox.referencedChunks(ns, hashes)) {
            names.add(hash);
          }
          return names;
        },
      },
      storage,
      sweep: {
        begin: () => outbox.beginSweep(sweeper, now),
        heartbeat: () => outbox.heartbeatSweep(sweeper, now),
        end: () => outbox.endSweep(sweeper),
      },
      clock: () => new Date(now),
    }).collect(SOLO_NAMESPACE, { signal });
    coverage.sweepDeletes += report.deleted;
  };

  const takeLease = async (takeover: boolean) => {
    if (takeover) {
      // Another copy's fence: raised in the store, never in this chain.
      fence++;
      await store.raiseWriterFence(fence);
      takeovers.push(step);
    }
    fence++;
    await store.raiseWriterFence(fence);
    await outbox.recordFence(fence);
    processId++;
    writer = { host: "h", pid: processId, instance: `p${processId}` };
  };

  /** Set while a recovery runs: its discards are reported drops. */
  let recovering = false;
  /** Removals a recovery makes before the power is cut; unset for none. */
  let cutAfterRemovals: number | undefined;
  /** Whether the recovery being cut has removed an entry yet. */
  let removedBeforeCut = false;
  const wrapRemoval = (kind: "settle" | "discard") => {
    const remove = outbox[kind].bind(outbox);
    outbox[kind] = async (keys: readonly OutboxKey[]) => {
      if (kind === "discard" && !recovering && take("fail-discard")) {
        throw new Error("database or disk is full");
      }
      if (cutAfterRemovals !== undefined) {
        if (cutAfterRemovals === 0) throw new Killed();
        cutAfterRemovals--;
        removedBeforeCut = true;
      }
      const removed: RemovedEntry[] = [];
      for (const key of keys) {
        if (recovering) {
          // A recovery settles only landed commits, so removing one that has
          // not landed is a drop, reported: it must never land later.
          const record = groups.get(key.txnId);
          if (
            record !== undefined && record.failedAt === undefined &&
            await landedSeq(record.txnId, record.run) === undefined
          ) {
            record.failedAt = step;
          }
        }
        const entry = diskDb().prepare(
          "SELECT * FROM outbox_entries WHERE namespace = ? AND partition = ? AND txn_id = ?",
        ).get(key.namespace, key.partition, key.txnId) as Row | undefined;
        if (entry === undefined) continue;
        const chunks = diskDb().prepare(
          "SELECT * FROM outbox_chunks WHERE sequence = ?",
        ).all(entry.sequence) as Row[];
        removed.push({ kind, entry, chunks });
      }
      await remove(keys);
      if (lastSynchronous !== SYNCHRONOUS_FULL) unsynced.push(...removed);
    };
  };
  wrapRemoval("settle");
  wrapRemoval("discard");
  const abandon = outbox.abandon.bind(outbox);
  outbox.abandon = (keys: readonly OutboxKey[]) => {
    if (take("fail-abandon")) {
      return Promise.reject(new Error("database or disk is full"));
    }
    return abandon(keys);
  };
  // The floor's write is fsynced: a cut before it loses the recovery's
  // relaxed removals.
  const raiseFloor = outbox.raiseFloor.bind(outbox);
  outbox.raiseFloor = (fence: number) => {
    if (cutAfterRemovals === 0 && removedBeforeCut) throw new Killed();
    return raiseFloor(fence);
  };

  /**
   * Cuts the power: the process dies, and the WAL keeps a prefix of the
   * removals since the last fsync, the first `keep`.
   */
  const cutPower = (keep: number) => {
    for (const lost of unsynced.slice(keep)) {
      restoreRows(diskDb(), "outbox_entries", [lost.entry]);
      restoreRows(diskDb(), "outbox_chunks", lost.chunks);
      coverage.undone[lost.kind]++;
    }
    unsynced = [];
    unit = undefined;
    writer = undefined;
  };

  const base = createOutboxCommitSink({ commitStore: store, outbox });
  const inner = base.outbox!;
  // Faults fire once per flush, at the first group that reaches them.
  const sink: CommitSink = {
    head: base.head,
    append: async (commit) => {
      if (take("sweep-before-append")) await sweep();
      if (take("fail-append")) {
        throw new Error("transient");
      }
      if (take("race-append")) {
        // Another commit lands on the partition first: a seq gap.
        await store.append(Commit.create({
          seq: commit.seq,
          partition: commit.partition,
          namespace: commit.namespace,
          txnId: crypto.randomUUID(),
          writer: writer!,
          ...(commit.fence !== undefined ? { fence: commit.fence } : {}),
          at: new Date(now).toISOString(),
          ops: commit.ops,
        }));
        coverage.seqGaps++;
      }
      const result = await base.append(commit);
      if (take("kill-after-append")) {
        throw new Killed();
      }
      return result;
    },
    outbox: {
      ...inner,
      headIdentity: async (namespace, partition) => {
        if (take("kill-before-prepare")) {
          throw new Killed();
        }
        if (take("sweep-before-prepare")) {
          await sweep();
        }
        return await inner.headIdentity(namespace, partition);
      },
      prepare: async (preparation) => {
        await inner.prepare(preparation);
        const { commit } = preparation;
        let record = groups.get(commit.txnId);
        if (record === undefined) {
          record = {
            txnId: commit.txnId,
            unit: unitIds.get(preparation.unitId) ??
              (unitIds.set(preparation.unitId, unitNo), unitNo),
            run: commit.partition.kind === "run",
            prepares: [],
          };
          groups.set(commit.txnId, record);
          partitionOfTxn.set(commit.txnId, commit.partition);
        }
        record.prepares.push({ step, base: preparation.base });
        if (take("kill-after-prepare")) {
          throw new Killed();
        }
        if (take("sweep-after-prepare")) {
          await sweep();
        }
        if (take("stray-commit-then-kill")) {
          // The partition moves on under the entry (a restore that replaced
          // its history), and the writer dies before its append.
          await store.append(Commit.create({
            seq: commit.seq,
            partition: commit.partition,
            namespace: commit.namespace,
            txnId: crypto.randomUUID(),
            writer: writer!,
            ...(commit.fence !== undefined ? { fence: commit.fence } : {}),
            at: new Date(now).toISOString(),
            ops: commit.ops,
          }));
          throw new Killed();
        }
      },
    },
  };

  const openUnit = () => {
    unitNo = nextUnit++;
    unit = createCommitLogUnitOfWork(() => Promise.resolve(), {
      sink,
      chunkStore,
      namespace: SOLO_NAMESPACE,
      writer: writer!,
      fence,
      signal,
      clock: () => new Date(now),
    });
    return unit;
  };

  /** Marks the unit's groups that did not land as reported failed. */
  const reportFailed = async (unitIndex: number) => {
    for (const record of groups.values()) {
      if (record.unit !== unitIndex || record.failedAt !== undefined) continue;
      if (await landedSeq(record.txnId, record.run) === undefined) {
        record.failedAt = step;
      }
    }
  };

  const flushUnder = async (
    selected: Fault,
    flush: () => Promise<void>,
    ends: boolean,
  ) => {
    for (const action of ACTIONS[selected]) actions.add(action);
    const unitIndex = unitNo;
    try {
      await flush();
    } catch (error) {
      // A kill met after a refusal in the same flush is that refusal's cause.
      if (error instanceof Killed || (error as Error).cause instanceof Killed) {
        coverage.kills++;
        // The process dies here: its unit never ends.
        unit = undefined;
        writer = undefined;
        return;
      }
      const refusals =
        (error as { refusals?: { partition: { kind: string } }[] })
          .refusals;
      if (refusals?.some((refusal) => refusal.partition.kind !== "run")) {
        coverage.refusals++;
        refusedAt.set(unitIndex, [...(refusedAt.get(unitIndex) ?? []), step]);
      }
      // A unit that could not record its failure says its commits may
      // land: no failure was reported.
      if (error instanceof MayLandLaterError) coverage.mayLand++;
      else if (ends) await reportFailed(unitIndex);
    } finally {
      actions.clear();
    }
  };

  /**
   * Abandons the open unit and marks its unlanded groups failed, unless the
   * unit says they may land: a drop or discard it could not record
   * (swamp-club#3645), as a flush's end does.
   */
  const endAbandoned = async (ending: CommitLogUnitOfWork) => {
    try {
      await ending.abandon();
    } catch (error) {
      if (!(error instanceof MayLandLaterError)) throw error;
      coverage.mayLand++;
      return;
    }
    await reportFailed(unitNo);
  };

  const recover = async () => {
    recovering = true;
    const report = await recoverCommitOutbox(
      { outbox, commitStore: store, chunkStore },
      {
        fence,
        writer: writer!,
        writerAlive: (w) => w.instance === writer!.instance,
        clock: () => new Date(now),
      },
    ).finally(() => recovering = false);
    coverage.landed += report.landed;
    coverage.settled += report.settled;
    for (const drop of report.drops) {
      coverage.drops[drop.reason] = (coverage.drops[drop.reason] ?? 0) + 1;
      if (drop.entry.commit.partition.kind === "run") continue;
      const record = groups.get(drop.entry.commit.txnId);
      if (record !== undefined) {
        refusedAt.set(record.unit, [
          ...(refusedAt.get(record.unit) ?? []),
          step,
        ]);
      }
    }
  };

  const check = async () => {
    for (const record of groups.values()) {
      const seq = await landedSeq(record.txnId, record.run);
      if (seq === undefined) continue;
      // A retry of a commit that had landed prepares again on the newer
      // head and settles as a duplicate: the landing is one prepare's.
      assert(
        record.prepares.some((prepare) => seq === prepare.base.seq + 1),
        `${record.txnId} landed at seq ${seq}, on no head it was prepared on`,
      );
    }
    // No stored commit names a missing chunk.
    for (
      const change of await store.changesSince(
        (await store.history()).compactedThrough,
        10_000,
      )
    ) {
      for (const op of change.commit.ops) {
        if (op.kind === "put" && "blob" in op.content) {
          assertEquals(
            await chunkStore.missing(SOLO_NAMESPACE, op.content.blob, signal),
            [],
            `commit ${change.commit.txnId} names a missing chunk`,
          );
        }
      }
    }
  };

  /** Whether each group's landing respects failures, takeovers and runs. */
  const landedAt = new Map<string, number>();
  const checkLandings = async () => {
    for (const record of groups.values()) {
      if (landedAt.has(record.txnId)) continue;
      if (await landedSeq(record.txnId, record.run) === undefined) continue;
      landedAt.set(record.txnId, step);
      if (record.failedAt !== undefined) {
        throw new Error(
          `${record.txnId} landed at step ${step} after its failure was reported at ${record.failedAt}`,
        );
      }
      const prepared = record.prepares.at(-1)!.step;
      const takenOver = takeovers.find((at) => at > prepared && at <= step);
      if (takenOver !== undefined && prepared < step) {
        throw new Error(
          `${record.txnId}, prepared at step ${prepared}, landed after another copy's lease at ${takenOver}`,
        );
      }
      if (record.run) {
        const firstPrepare = record.prepares[0].step;
        for (const refused of refusedAt.get(record.unit) ?? []) {
          if (refused > firstPrepare) continue;
          const acked = (acknowledged.get(record.unit) ?? []).some((at) =>
            at >= refused && at <= firstPrepare
          );
          if (!acked && prepared >= refused) {
            throw new Error(
              `run ${record.txnId} landed after its unit's data was refused at ${refused}`,
            );
          }
        }
      }
    }
  };

  coverage.runs++;
  try {
    await takeLease(false);
    for (const command of commands) {
      step++;
      switch (command.kind) {
        case "stage": {
          if (writer === undefined) break;
          const id = IDS[command.target];
          const content = command.big
            ? new Uint8Array(40 * 1024).fill(++stagedBlob % 250)
            : new TextEncoder().encode(`v${step}`);
          await (unit ?? openUnit()).stageOps([
            new AutoDefinitionChanges(id).write(
              recordKeyOf(["auto-definitions", `${id}.yaml`]),
              content,
            ),
          ]);
          break;
        }
        case "stage-run":
          if (writer === undefined) break;
          await (unit ?? openUnit()).stageOp({
            partition: runPartition(),
            op: await runPut(`run ${step}`),
          });
          break;
        case "stage-refused":
          if (writer === undefined) break;
          // Absent the first time; refused every time after.
          await (unit ?? openUnit()).stageOp({
            partition: modelPartition(),
            op: await savePut("x", 1, `x${step}`, "absent"),
          });
          break;
        case "checkpoint":
          if (unit === undefined) break;
          await flushUnder(command.fault, () => unit!.checkpoint(), false);
          break;
        case "commit": {
          if (unit === undefined) break;
          const ending = unit;
          await flushUnder(command.fault, () => ending.commit(), true);
          if (unit === ending) unit = undefined;
          break;
        }
        case "abandon":
          if (unit === undefined) break;
          await endAbandoned(unit);
          unit = undefined;
          break;
        case "acknowledge":
          if (unit === undefined) break;
          unit.acknowledgeRefusals();
          acknowledged.set(unitNo, [...(acknowledged.get(unitNo) ?? []), step]);
          break;
        case "restart": {
          // A live process ends its unit first; a killed one left it.
          if (unit !== undefined) {
            await endAbandoned(unit);
            unit = undefined;
          }
          await takeLease(command.takeover);
          if (command.cutAfter !== undefined) {
            cutAfterRemovals = command.cutAfter;
            removedBeforeCut = false;
            try {
              await recover();
            } catch (error) {
              if (!(error instanceof Killed)) throw error;
              coverage.recoveryCuts++;
              cutPower(command.cutKeep ?? 0);
              // A new writer, under a new fence.
              await takeLease(false);
            } finally {
              cutAfterRemovals = undefined;
            }
          }
          await recover();
          break;
        }
        case "compact": {
          const history = await store.history();
          const last =
            (await store.changesSince(history.compactedThrough, 10_000))
              .at(-1)?.cursor;
          if (last !== undefined) {
            await store.compactHistory(last, {
              fence,
              pruneTxnsBefore: new Date(now - COMPACTED_TXN_RETENTION_MS),
            });
          }
          break;
        }
        case "age":
          now += OUTBOX_RETRY_BOUND_MS + 60_000;
          break;
        case "sweep":
          await sweep();
          break;
        case "power-cut":
          cutPower(command.keep);
          await takeLease(false);
          await recover();
          break;
      }
      await checkLandings();
      await check();
    }
  } finally {
    disk?.close();
    await store.close();
    await outbox.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const arbInterleaving = fc.array(arbCommand, { minLength: 1, maxLength: 40 });

/**
 * Each a discard after a reported failure or drop, then a power cut before
 * anything else fsyncs the outbox (swamp-club#3506): rare in random runs.
 */
const STAGE: Command = { kind: "stage", target: 0, big: false };
const CUT: Command = { kind: "power-cut", keep: 0 };
const DISCARD_THEN_CUT: Command[][] = [
  [STAGE, { kind: "commit", fault: "fail-append" }, CUT],
  [
    STAGE,
    { kind: "checkpoint", fault: "fail-append" },
    { kind: "commit", fault: "fail-append" },
    CUT,
  ],
  [
    STAGE,
    { kind: "checkpoint", fault: "fail-append" },
    { kind: "abandon" },
    CUT,
  ],
  // A killed writer leaves a run entry and its unit's data entry; the next
  // recovery drops the data entry (head moved) and the run entry with it,
  // and power is cut before the floor, keeping only the first drop. The run
  // partition's head is unchanged: only the run entry's fsynced drop keeps
  // the run record from landing at the recovery after.
  [
    { kind: "stage-run" },
    { kind: "checkpoint", fault: "fail-append" },
    STAGE,
    { kind: "checkpoint", fault: "stray-commit-then-kill" },
    { kind: "restart", takeover: false, cutAfter: 2, cutKeep: 1 },
  ],
];

/**
 * An aged entry dropped by a retry whose discard and mark both fail: the
 * abandon at the restart says the commit may land (swamp-club#3645).
 */
const ABANDON_MAY_LAND: Command[] = [
  STAGE,
  { kind: "checkpoint", fault: "fail-append-and-discard" },
  { kind: "age" },
  { kind: "checkpoint", fault: "fail-append-discard-and-mark" },
  { kind: "restart", takeover: false },
];

for (const ending of ["abandon", "restart"] as const) {
  Deno.test(`v3 outbox (model): ${ending} preserves an expired checkpoint's uncertain outcome through recovery and a power cut (swamp-club#3685)`, async () => {
    const mayLand = coverage.mayLand;
    await runModel([
      { kind: "stage-refused" },
      { kind: "checkpoint", fault: "fail-append-and-discard" },
      { kind: "age" },
      { kind: "checkpoint", fault: "fail-append-discard-and-mark" },
      ending === "restart"
        ? { kind: "restart", takeover: false }
        : { kind: "abandon" },
      CUT,
    ]);
    assertEquals(coverage.mayLand, mayLand + 1);
  });
}

Deno.test("v3 outbox (model): over random interleavings no commit lands after its failure, a takeover or off its head, no run names refused data, and no commit names a missing chunk", async () => {
  await fc.assert(fc.asyncProperty(arbInterleaving, runModel), {
    numRuns: 1000,
    examples: [...DISCARD_THEN_CUT, ABANDON_MAY_LAND].map((
      commands,
    ): [Command[]] => [commands]),
  });
});

Deno.test("v3 outbox (model): the interleavings take every path the invariants guard", async () => {
  // A fixed seed, so what is reached does not vary between runs.
  for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) {
    if (key !== "drops" && key !== "undone") coverage[key] = 0;
  }
  coverage.drops = {};
  coverage.undone = { settle: 0, discard: 0 };
  await fc.assert(fc.asyncProperty(arbInterleaving, runModel), {
    numRuns: 1000,
    seed: 3490,
  });
  const reached = JSON.stringify(coverage);
  assert(
    coverage.kills > 0 && coverage.landed > 0 && coverage.settled > 0,
    reached,
  );
  assert(coverage.refusals > 0 && coverage.seqGaps > 0, reached);
  assert(coverage.sweepDeletes > 0, reached);
  // A power cut undoes settles, and cuts recoveries part way; a discard is
  // fsynced, so none is ever undone.
  assert(coverage.undone.settle > 0 && coverage.recoveryCuts > 0, reached);
  assertEquals(coverage.undone.discard, 0, reached);
  // A unit-dropped run entry needs a failed run commit and a later data
  // commit of one unit both left behind; the recovery unit tests pin it.
  assert(coverage.mayLand > 0, reached);
  for (const reason of ["stale-fence", "head-moved", "expired", "abandoned"]) {
    assert((coverage.drops[reason] ?? 0) > 0, `${reason}: ${reached}`);
  }
});
