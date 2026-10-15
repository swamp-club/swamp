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
 * passing the retry bound, and chunk sweeps landing inside a commit, the
 * real unit, sink, outbox, commit store and collector keep:
 *
 * - a commit whose failure was reported never lands later;
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
} from "../src/domain/datastore_v3/commit_outbox.ts";
import type { CommitLogUnitOfWork } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
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
  | "sweep-before-append-then-kill";

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
};

type Command =
  | { readonly kind: "stage"; readonly target: number; readonly big: boolean }
  | { readonly kind: "stage-run" }
  | { readonly kind: "stage-refused" }
  | { readonly kind: "checkpoint"; readonly fault: Fault }
  | { readonly kind: "commit"; readonly fault: Fault }
  | { readonly kind: "abandon" }
  | { readonly kind: "acknowledge" }
  | { readonly kind: "restart"; readonly takeover: boolean }
  | { readonly kind: "compact" }
  | { readonly kind: "age" }
  | { readonly kind: "sweep" };

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
    }),
    weight: 3,
  },
  { arbitrary: fc.constant({ kind: "compact" as const }), weight: 1 },
  { arbitrary: fc.constant({ kind: "age" as const }), weight: 2 },
  { arbitrary: fc.constant({ kind: "sweep" as const }), weight: 1 },
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
  drops: {} as Record<string, number>,
};

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
  const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"), {
    clock: () => new Date(now),
  });
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
      if (ends) await reportFailed(unitIndex);
    } finally {
      actions.clear();
    }
  };

  const recover = async () => {
    const report = await recoverCommitOutbox(
      { outbox, commitStore: store, chunkStore },
      {
        fence,
        writer: writer!,
        writerAlive: (w) => w.instance === writer!.instance,
        clock: () => new Date(now),
      },
    );
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
          await unit.abandon();
          await reportFailed(unitNo);
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
            await unit.abandon();
            await reportFailed(unitNo);
            unit = undefined;
          }
          await takeLease(command.takeover);
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
      }
      await checkLandings();
      await check();
    }
  } finally {
    await store.close();
    await outbox.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const arbInterleaving = fc.array(arbCommand, { minLength: 1, maxLength: 40 });

Deno.test("v3 outbox (model): over random interleavings no commit lands after its failure, a takeover or off its head, no run names refused data, and no commit names a missing chunk", async () => {
  await fc.assert(fc.asyncProperty(arbInterleaving, runModel), {
    numRuns: 1000,
  });
});

Deno.test("v3 outbox (model): the interleavings take every path the invariants guard", async () => {
  // A fixed seed, so what is reached does not vary between runs.
  for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) {
    if (key !== "drops") coverage[key] = 0;
  }
  coverage.drops = {};
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
  // A unit-dropped run entry needs a failed run commit and a later data
  // commit of one unit both left behind; the recovery unit tests pin it.
  for (const reason of ["stale-fence", "head-moved", "expired"]) {
    assert((coverage.drops[reason] ?? 0) > 0, `${reason}: ${reached}`);
  }
});
