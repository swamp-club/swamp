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
 * each partition commits on its own, workflow-run partitions last, so a run
 * record never names unlanded data; no atomicity across partitions: earlier
 * ones stay committed, later ones are not tried
 */

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import type { Namespace } from "../../domain/data/namespace.ts";
import type { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import type {
  ChunkBatch,
  ChunkStore,
} from "../../domain/datastore_v3/chunk_store.ts";
import {
  Commit,
  type CommitWriter,
  MAX_COMMIT_OPS,
} from "../../domain/datastore_v3/commit.ts";
import {
  type CommitLogUnitOfWork,
  CommitUnreachableError,
  type ContentSource,
  MayLandLaterError,
  type PartitionRefusal,
  PartitionsRefusedError,
  type PendingPut,
  RunPartlyCommittedError,
  type TypedChange,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import type { CommitStore } from "../../domain/datastore_v3/commit_store.ts";
import {
  createIntent,
  intentPartition,
} from "../../domain/datastore_v3/intent.ts";
import {
  isOp,
  MAX_INLINE_BYTES,
  type Op,
  type PutOp,
  putOp,
  tombstoneOp,
} from "../../domain/datastore_v3/op.ts";
import {
  type HeadIdentity,
  OUTBOX_RETRY_BOUND_DAYS,
  OUTBOX_RETRY_BOUND_MS,
  type OutboxKey,
  type OutboxPreparation,
  sweepMayOverlap,
  type SweepState,
} from "../../domain/datastore_v3/commit_outbox.ts";
import type { ConfigEditBases } from "../../domain/datastore_v3/config_edit_bases.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  typedStagers,
  unitAdmissions,
  unitOfWorkBinding,
  unitWrites,
  versionFloors,
  type VersionFloorSource,
} from "../persistence/unit_of_work_binding.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { inUserConfigEdit } from "./config_edit_scope.ts";
import type { RecordLastChange } from "./record_last_change.ts";
import { isNetworkFailure } from "./network_failure.ts";

const logger = getSwampLogger(["datastore", "v3"]);

/**
 * a bare CommitStore appends directly; a v3 datastore's sink also carries the
 * outbox
 */
export type CommitSink = Pick<CommitStore, "append" | "head"> & {
  readonly dataHighWater?: (
    namespace: string,
    partition: PartitionKey,
    name: string,
  ) => Promise<number>;
  readonly outbox?: SinkOutbox;
  /**
   * 2 when absent; serve's sink catches up and retries a stale seq, which other
   * writers can move more than once
   */
  readonly seqGapAttempts?: number;
  /**
   * a commit queued offline is prepared already marked offline, so a process
   * that dies before the queue's mark still leaves an entry no drop rule takes
   */
  readonly queuesOffline?: (partition: PartitionKey) => Promise<boolean>;
};

/**
 * covers versions staged but not committed yet, which the commit store cannot
 * see (same unit, sibling unit, deferred write); one number per name, so never
 * evicted
 */
const claimedVersions = new WeakMap<CommitSink, Map<string, number>>();

/**
 * A unit's version-floor source: the floor is the greater of the name's
 * committed high-water mark and the greatest version this process gave it.
 */
function floorSourceFor(
  sink: CommitSink,
  namespace: string,
): Omit<VersionFloorSource, "allocated"> {
  let claimed = claimedVersions.get(sink);
  if (claimed === undefined) {
    claimed = new Map();
    claimedVersions.set(sink, claimed);
  }
  const marks = claimed;
  const keyOf = (partition: string, name: string) =>
    JSON.stringify([namespace, partition, name]);
  return {
    async floor(partition, name) {
      const committed = sink.dataHighWater === undefined
        ? 0
        : await sink.dataHighWater(
          namespace,
          PartitionKey.parse(partition),
          name,
        );
      return Math.max(committed, marks.get(keyOf(partition, name)) ?? 0);
    },
    claim(partition, name, version) {
      const key = keyOf(partition, name);
      marks.set(key, Math.max(marks.get(key) ?? 0, version));
    },
  };
}

export interface SinkOutbox {
  headIdentity(
    namespace: string,
    partition: PartitionKey,
  ): Promise<HeadIdentity>;
  /**
   * Records a commit about to be appended. Refuses when this process no
   * longer holds the writer lease.
   */
  prepare(preparation: OutboxPreparation): Promise<void>;
  /** Removes the entries of commits that landed; need not be fsynced. */
  settle(keys: readonly OutboxKey[]): Promise<void>;
  /** Removes entries the unit gave up; fsynced, since the failure was reported. */
  discard(keys: readonly OutboxKey[]): Promise<void>;
  /**
   * marks entries the unit gave up, fsynced, before they are discarded:
   * recovery never lands a marked entry
   */
  abandon?(keys: readonly OutboxKey[]): Promise<void>;
  /**
   * marks entries queued while serve was unreachable, fsynced: they are kept
   * until a later command lands them
   */
  queue?(keys: readonly OutboxKey[]): Promise<void>;
  /**
   * The seq a txnId landed at, if it did: read after an append fails, since
   * a writer that took over may have landed the prepared commit.
   */
  landedSeq?(
    namespace: string,
    partition: PartitionKey,
    txnId: string,
  ): Promise<number | undefined>;
  sweepState(): Promise<SweepState>;
  /**
   * Resolves once the chunk sweep batch this process is running, if any,
   * has deleted its chunks and re-checked their references.
   */
  sweepBatch?(): Promise<void>;
}

export interface CommitLogUnitOptions {
  readonly sink: CommitSink;
  readonly chunkStore: ChunkStore;
  readonly namespace: Namespace;
  readonly writer: CommitWriter;
  /** The writer's fence (its writer lease's or leader lease's), if any. */
  readonly fence?: number;
  /**
   * Bounds content uploads for the whole operation the unit serves, every
   * checkpoint and the final commit included; an abort rejects the commit
   * in progress.
   */
  readonly signal: AbortSignal;
  readonly clock?: () => Date;
  /**
   * The unit that was ambient when this one opened. The new unit is its
   * child when it is an open commit-log unit for the same hook, or the
   * child of its nearest open ancestor when it has ended; otherwise a root.
   */
  readonly parent?: UnitOfWork;
  /**
   * false for a key the configured directories leave out or exclude patterns
   * match, which stays in the checkout and is never committed; every key
   * belongs when absent
   */
  readonly admits?: (key: string) => boolean;
  /**
   * told when the unit opens and ends, and when it drops work a repository may
   * already have written to the checkout
   */
  readonly tracker?: UnitTracker;
  /**
   * inside a user's edit, an edited definition expects its base rather than the
   * version the repository read when it saved; told each record this unit
   * commits
   */
  readonly configEditBases?: ConfigEditBases;
  /** for a refused expectation's message; the refusal names neither when absent */
  readonly lastChangeOf?: (
    partition: PartitionKey,
    key: string,
  ) => Promise<RecordLastChange>;
  /**
   * undefined when never measured; when given, each commit records when it ran
   * and the offset, so a commit queued offline is judged on reconnect by when
   * it ran
   */
  readonly clockOffsetMs?: () => number | undefined;
}

export interface UnitTracker {
  opened(): void;
  ended(): void;
  /**
   * openedAt is its root's open time in epoch ms: nothing it wrote is older;
   * sentTxnIds are the commits handed to its sink, landed or not, which the
   * checkout's later dropped writes may overlay
   */
  dropped(
    openedAt: number,
    versionDirs: readonly string[],
    sentTxnIds: readonly string[],
  ): void;
}

export class PathOnlyChangeRefusedError extends Error {
  constructor(readonly change: StagedChange) {
    const target = change.kind === "bulk" ? change.reason : change.path;
    super(
      `A datastore ${change.kind} of ${target} was staged without its intent ` +
        "and content; a v3 datastore commits only typed changes, so it was " +
        "refused",
    );
    this.name = "PathOnlyChangeRefusedError";
  }
}

interface Group {
  readonly partition: PartitionKey;
  /** Fixed when the group forms, so a retry of its commit lands once. */
  readonly txnId: string;
  readonly formedAt: number;
  readonly changes: readonly TypedChange[];
  /**
   * The flush that formed it. A partition's changes split into several
   * groups when they pass MAX_COMMIT_OPS; the splits formed together share
   * this, so a refusal of one drops the splits after it.
   */
  readonly formation: number;
  /**
   * the head its client built on; the commit is refused rather than rebuilt
   * when the head has moved
   */
  readonly expectedSeq?: number;
  readonly principal?: string;
}

interface CommitLogState {
  readonly hook: MarkDirtyHook;
  isOpen(): boolean;
  readonly parent: UnitOfWork | undefined;
  readonly openedAt: number;
  adopt(
    batches: readonly (readonly TypedChange[])[],
    versionDirs?: readonly string[],
  ): void;
  /**
   * hands what the unit has staged to its nearest open ancestor and stays open;
   * a no-op on an ended unit
   */
  promote(): void;
  skipSuperseded(change: TypedChange): void;
}

const states = new WeakMap<UnitOfWork, CommitLogState>();

export function commitLogParentFor(
  markDirty: MarkDirtyHook,
  candidate: UnitOfWork | undefined,
): UnitOfWork | undefined {
  if (candidate === undefined) return undefined;
  const state = states.get(candidate);
  if (state === undefined || state.hook !== markDirty) return undefined;
  return state.isOpen() ? candidate : nearestOpenAncestor(state.parent);
}

function nearestOpenAncestor(
  parent: UnitOfWork | undefined,
): UnitOfWork | undefined {
  let unit = parent;
  while (unit !== undefined) {
    const state = states.get(unit);
    if (state === undefined) return undefined;
    if (state.isOpen()) return unit;
    unit = state.parent;
  }
  return undefined;
}

/**
 * handed-over changes belong to the root; a later abandon discards only later
 * staging; a later put or tombstone supersedes an unread handed-over stream
 * put, which is skipped, not read from a changed file
 */
export async function checkpointFrom(unit: UnitOfWork): Promise<boolean> {
  let current: UnitOfWork | undefined = unit;
  while (current !== undefined) {
    const state = states.get(current);
    if (state === undefined) return false;
    if (state.parent === undefined) {
      if (!state.isOpen()) return false;
      await (current as CommitLogUnitOfWork).checkpoint();
      return true;
    }
    // Every ancestor ended, the root included: nothing can commit now.
    if (nearestOpenAncestor(state.parent) === undefined) return false;
    state.promote();
    current = nearestOpenAncestor(state.parent);
  }
  return false;
}

export function createCommitLogUnitOfWork(
  markDirty: MarkDirtyHook,
  options: CommitLogUnitOptions,
): CommitLogUnitOfWork {
  const parent = commitLogParentFor(markDirty, options.parent);
  const clock = options.clock ?? (() => new Date());
  const openedAt = parent === undefined
    ? clock().getTime()
    : states.get(parent)!.openedAt;
  /**
   * whether a repository wrote into this unit (a write signal or any recorded
   * change, a committed child's included); only such a unit's dropped work can
   * be in the checkout
   */
  let touched = false;
  let versionDirs: string[] = [];
  /**
   * a refusal that drops only some partitions names them: the commits the unit
   * sent to the others still hold work it goes on to commit
   */
  const dropWork = (partitions?: readonly PartitionKey[]): void => {
    if (!touched) return;
    const named = partitions?.map((partition) => partition.toString());
    const sentTxnIds = [...outbox.sent]
      .filter(([, partition]) => named?.includes(partition) ?? true)
      .map(([txnId]) => txnId);
    try {
      options.tracker?.dropped(openedAt, versionDirs, sentTxnIds);
    } catch (error) {
      logger
        .warn`Recording the work a v3 unit of work dropped failed: ${error}`;
    }
  };
  const all: TypedChange[] = [];
  /**
   * Batches not yet formed into groups, in staging order. A batch is the
   * changes one `stageOps` call recorded; groups split only between them.
   */
  let staged: TypedChange[][] = [];
  let pending: Group[] = [];
  /** so a failed end can say what was committed */
  const landed: PartitionKey[] = [];
  let inFlight: Group | undefined;
  const stored = new WeakMap<PendingPut, PutOp>();
  /**
   * superseded stream puts that stay in their group (unstored ones in the group
   * being appended, and stored ones): skipped when reached, or when a retry
   * finds chunks missing, instead of reading the source again
   */
  const supersededInFlight = new WeakSet<PendingPut>();
  const streamPuts = new Map<
    string,
    { readonly batch: TypedChange[]; readonly change: TypedChange }
  >();
  let formations = 0;
  let ended: "committed" | "abandoned" | undefined;
  /**
   * non-run partitions refused since the last acknowledgement: while any is,
   * run partitions stay pending
   */
  let refusals: PartitionRefusal[] = [];
  let flushing: Promise<void> = Promise.resolve();
  /**
   * a refusal whose entries could be neither discarded nor marked abandoned:
   * the unit's end says its changes may still land
   */
  let unconfirmed:
    | { readonly cause: unknown; readonly reason: unknown }
    | undefined;
  const outbox: UnitOutbox = {
    unitId: crypto.randomUUID(),
    prepared: new Map(),
    sent: new Map(),
  };

  /**
   * a later put or tombstone of the same key leaves the same record, and the
   * file behind the stream may be gone by commit (prune, delete, in-place
   * append); covers unflushed batches and pending groups not in flight
   */
  const elideSupersededBy = (change: TypedChange): void => {
    const slot = supersedingSlot(change);
    if (slot === undefined) return;
    const earlier = streamPuts.get(slot);
    if (earlier !== undefined) {
      earlier.batch.splice(earlier.batch.indexOf(earlier.change), 1);
      streamPuts.delete(slot);
    }
    pending = pending.flatMap((group) => {
      if (group === inFlight) {
        for (const other of group.changes) {
          if ("put" in other && streamPutSlot(other) === slot) {
            supersededInFlight.add(other.put);
          }
        }
        return [group];
      }
      const changes = group.changes.filter((other) => {
        if (!("put" in other) || streamPutSlot(other) !== slot) return true;
        if (!stored.has(other.put)) return false;
        // A stored put's op is kept; a retry that finds its chunks missing
        // skips it rather than read a source that may be gone.
        supersededInFlight.add(other.put);
        return true;
      });
      if (changes.length === group.changes.length) return [group];
      // A group left empty has nothing to commit; a commit carries an op.
      return changes.length === 0 ? [] : [{ ...group, changes }];
    });
  };

  /**
   * marks queued stream puts to be skipped when their group is appended,
   * without removing them, since change is still a descendant's and may be
   * abandoned; unformed batches are elided by the next flush
   */
  const skipSuperseded = (change: TypedChange): void => {
    const slot = supersedingSlot(change);
    if (slot === undefined) return;
    for (const group of pending) {
      for (const other of group.changes) {
        if ("put" in other && streamPutSlot(other) === slot) {
          supersededInFlight.add(other.put);
        }
      }
    }
  };

  /**
   * Whether this unit has handed batches to an ancestor while open: its
   * later changes may then supersede puts the ancestor is appending.
   */
  let promoted = false;

  const record = (changes: readonly TypedChange[]): void => {
    requireBatchWithinLimit(changes);
    if (changes.length === 0) return;
    touched = true;
    const batch: TypedChange[] = [];
    staged.push(batch);
    for (const change of changes) {
      if (promoted) {
        for (
          let unit = nearestOpenAncestor(parent);
          unit !== undefined;
          unit = nearestOpenAncestor(states.get(unit)!.parent)
        ) {
          states.get(unit)!.skipSuperseded(change);
        }
      }
      elideSupersededBy(change);
      batch.push(change);
      all.push(change);
      const slot = streamPutSlot(change);
      if (slot !== undefined) streamPuts.set(slot, { batch, change });
    }
  };

  const flush = (): Promise<void> => {
    const run = flushing.then(async () => {
      pending = [
        ...pending,
        ...formGroups(staged, ++formations, clock().getTime()),
      ];
      staged = [];
      streamPuts.clear();
      // Run partitions last (decision 7); a stable sort keeps the rest in
      // the order they were formed, so a partition's splits stay in order.
      pending.sort((a, b) => runRank(a) - runRank(b));
      const refusedNow: PartitionRefusal[] = [];
      // A run record may name data a refused partition did not record, so
      // run groups wait while a refusal is unacknowledged. They sort last,
      // so the first group not held is the next to append; it is read from
      // `pending` each time, which staging may change between appends.
      const held = (group: Group) =>
        runRank(group) === 1 && refusals.length > 0;
      while (true) {
        const group = pending.find((other) => !held(other));
        if (group === undefined) break;
        inFlight = group;
        let withdrawn = false;
        try {
          withdrawn = await appendGroup(
            group,
            options,
            clock,
            stored,
            supersededInFlight,
            outbox,
          );
        } catch (error) {
          // A seq gap only means another append moved the head first; the
          // group stays pending, is rebuilt at the new head, and the flush
          // stops as for any other failure.
          if (
            !(error instanceof CommitRejectedError) ||
            error.reason === "seq-gap"
          ) {
            // A refusal met earlier in this flush is never lost behind it:
            // the caller sees the refusal, with this error as its cause, and
            // the failed group stays pending for the next flush.
            if (refusedNow.length > 0 || refusals.length > 0) {
              throw refusedError(refusedNow, error);
            }
            throw error;
          }
          // A refused commit can never land as it is: drop it, with the
          // splits of its partition formed with it (they were staged after
          // it), and go on, so the partitions staged after it still commit.
          const dropped = pending.filter((other) =>
            other === group ||
            (other.formation === group.formation &&
              other.partition.equals(group.partition))
          );
          pending = pending.filter((other) => !dropped.includes(other));
          // with the refused entries go the unit's run entries, so a recovery
          // never lands a run record that names what was refused
          const lost = await discardEntries(
            options,
            outbox,
            [...dropped, ...pending.filter((other) => runRank(other) === 1)],
          );
          if (lost !== undefined && unconfirmed === undefined) {
            unconfirmed = { cause: error, reason: lost.reason };
          }
          const refusal: PartitionRefusal = {
            partition: group.partition,
            reason: error.reason,
            message: error.message,
            ...await refusedRecord(error, group.partition, options),
            versions: dropped.flatMap((other) => recordedVersions(other)),
          };
          refusedNow.push(refusal);
          if (runRank(group) === 0) refusals = [...refusals, refusal];
          dropWork([group.partition]);
          continue;
        } finally {
          inFlight = undefined;
        }
        pending = pending.filter((other) => other !== group);
        if (withdrawn) continue;
        noteCommitted(group, options);
        if (!landed.some((other) => other.equals(group.partition))) {
          landed.push(group.partition);
        }
      }
      // Every flush throws until the refusals are acknowledged, so none is
      // ever cleared unseen.
      if (refusedNow.length > 0 || refusals.length > 0) {
        throw refusedError(refusedNow);
      }
    });
    flushing = run.catch(() => {});
    return run;
  };

  const refusedError = (
    refusedNow: readonly PartitionRefusal[],
    cause?: unknown,
  ): PartitionsRefusedError =>
    new PartitionsRefusedError(
      [
        ...refusals,
        ...refusedNow.filter((refusal) => refusal.partition.kind === "run"),
      ],
      refusals.length === 0
        ? []
        : pending.filter((group) => runRank(group) === 1).map((group) =>
          group.partition
        ),
      cause,
    );

  const state: CommitLogState = {
    hook: markDirty,
    isOpen: () => ended === undefined,
    parent,
    openedAt,
    adopt(batches, dirs = []) {
      for (const batch of batches) record(batch);
      if (dirs.length > 0) touched = true;
      for (const dir of dirs) versionDirs.push(dir);
    },
    promote() {
      if (ended !== undefined || staged.length === 0) return;
      const target = nearestOpenAncestor(parent);
      if (target === undefined) {
        throw new Error(
          "promote called on a unit of work with no open ancestor; a root " +
            "commits its own changes",
        );
      }
      promoted = true;
      states.get(target)!.adopt(staged);
      staged = [];
      streamPuts.clear();
    },
    skipSuperseded,
  };

  const end = async (as: "committed" | "abandoned"): Promise<void> => {
    if (ended !== undefined) throw new Error(`unit of work already ${ended}`);
    ended = as;
    // told only once the final flush and its discards are done: a recovery of
    // dropped work waits for every open unit
    try {
      await finish(as);
    } finally {
      options.tracker?.ended();
    }
  };

  const throwUnconfirmed = (): void => {
    if (unconfirmed !== undefined) {
      throw new MayLandLaterError(unconfirmed.cause, unconfirmed.reason);
    }
  };

  const finish = async (as: "committed" | "abandoned"): Promise<void> => {
    if (as === "abandoned") {
      await flushing;
      staged = [];
      streamPuts.clear();
      const abandoned = pending;
      pending = [];
      refusals = [];
      dropWork();
      const lost = await discardEntries(options, outbox, abandoned);
      if (lost !== undefined) {
        throw new MayLandLaterError(undefined, lost.reason);
      }
      throwUnconfirmed();
      return;
    }
    if (parent !== undefined) {
      const target = states.get(parent)?.isOpen()
        ? parent
        : nearestOpenAncestor(parent);
      if (target === undefined) {
        dropWork();
        throw new Error(
          "a child unit of work committed after its root ended; its changes " +
            "were not committed",
        );
      }
      states.get(target)!.adopt(staged, versionDirs);
      staged = [];
      versionDirs = [];
      streamPuts.clear();
      return;
    }
    // The partitions with changes the end did not commit: its failed groups
    // and, when it failed before forming them, its staged changes.
    let unlanded: readonly PartitionKey[] = [];
    try {
      await flush();
    } catch (error) {
      unlanded = [
        ...pending.map((group) => group.partition),
        ...staged.flat().map((change) => change.partition),
      ];
      // the unit ends with these commits failed and the caller is told so, so a
      // later recovery must not land them; when that cannot be recorded the
      // caller is told they may land
      dropWork();
      // a commit that may have reached serve keeps its entry so the next
      // recovery settles or sends it; the caller is told it may land
      const lost = error instanceof MayLandLaterError
        ? unconfirmed
        : await discardEntries(options, outbox, pending) ?? unconfirmed;
      if (lost !== undefined && !(error instanceof MayLandLaterError)) {
        throw new MayLandLaterError(error, lost.reason);
      }
      // given up, so nothing of it can land: a commit that never reached the
      // storage says so and a retry is safe; a run whose checkpoint landed is
      // left running instead
      if (lost === undefined && failedReachingStorage(error)) {
        // A run whose record landed earlier and whose latest save did not
        // is left running; one whose saves all landed is not.
        const runs = landed.flatMap((partition) => {
          const identity = partition.identity;
          return identity.kind === "run" &&
              unlanded.some((other) => other.equals(partition))
            ? [{ workflowId: identity.workflowId, runId: identity.runId }]
            : [];
        });
        if (runs.length > 0) throw new RunPartlyCommittedError(error, runs);
        throw new CommitUnreachableError(error, {
          partly: landed.length > 0,
        });
      }
      throw error;
    }
    throwUnconfirmed();
  };

  const uow: CommitLogUnitOfWork = {
    stageOp(change: TypedChange): Promise<void> {
      return uow.stageOps([change]);
    },
    async stageOps(changes: readonly TypedChange[]): Promise<void> {
      const checked: TypedChange[] = [];
      for (const change of changes) {
        const key = keyOfChange(change);
        if (key !== undefined && options.admits?.(key) === false) continue;
        checked.push(rebased(await checkChange(change), options));
      }
      if (checked.length === 0) return;
      // Each refusal below comes after the repository wrote the files.
      const refuse = (error: Error): never => {
        touched = true;
        dropWork();
        throw error;
      };
      try {
        requireBatchWithinLimit(checked);
      } catch (error) {
        refuse(error as Error);
      }
      if (ended === "abandoned") {
        // Abandon discards: a write still landing in an abandoned unit's
        // scope is discarded with it, not rolled into an ancestor.
        refuse(new Error("unit of work already abandoned"));
      }
      if (ended !== undefined) {
        const ancestor = nearestOpenAncestor(parent);
        if (ancestor !== undefined) {
          return await (ancestor as CommitLogUnitOfWork).stageOps(checked);
        }
        refuse(new Error(`unit of work already ${ended}`));
      }
      record(checked);
    },
    stage(change: StagedChange): Promise<void> {
      return Promise.reject(new PathOnlyChangeRefusedError(change));
    },
    async checkpoint(): Promise<void> {
      if (ended !== undefined) {
        throw new Error(`checkpoint called after the unit of work ${ended}`);
      }
      if (parent !== undefined) {
        throw new Error(
          "checkpoint called on a child unit of work; its root commits",
        );
      }
      await flush();
    },
    acknowledgeRefusals(): void {
      if (parent !== undefined) {
        throw new Error(
          "acknowledgeRefusals called on a child unit of work; its root holds " +
            "the run records",
        );
      }
      refusals = [];
    },
    commit: () => end("committed"),
    abandon: () => end("abandoned"),
    staged: () => Object.freeze([]),
    stagedOps: () => Object.freeze([...all]),
  };
  states.set(uow, state);
  unitOfWorkBinding.bind(uow, markDirty);
  unitWrites.register(uow, () => {
    touched = true;
  });
  options.tracker?.opened();
  if (options.admits !== undefined) {
    unitAdmissions.register(uow, options.admits);
  }
  const floors = floorSourceFor(options.sink, options.namespace.toString());
  versionFloors.register(uow, {
    floor: floors.floor,
    claim: floors.claim,
    allocated(dir) {
      // A created version directory is a write into the checkout.
      touched = true;
      versionDirs.push(dir);
    },
  });
  typedStagers.register(
    uow,
    (changes) => uow.stageOps(changes),
    () => state.isOpen() ? uow : nearestOpenAncestor(parent),
  );
  return uow;
}

function keyOfChange(change: TypedChange): string | undefined {
  if ("put" in change) return change.put.key.toString();
  const op = change.op;
  return "key" in op ? op.key.toString() : undefined;
}

/**
 * inside a user's edit, an edit of a managed-config definition another writer
 * replaced in this process expects the version the user started from; other
 * changes are left as staged
 */
function rebased(
  change: TypedChange,
  options: CommitLogUnitOptions,
): TypedChange {
  const bases = options.configEditBases;
  if (
    bases === undefined || change.partition.kind !== "config" ||
    !inUserConfigEdit()
  ) {
    return change;
  }
  const baseOf = (key: RecordKey) =>
    bases.baseOf(
      options.namespace.toString(),
      change.partition.toString(),
      key.toString(),
    );
  if ("put" in change) {
    const put = change.put;
    // Only an edit in place: a create, a move and a rename expect the key
    // absent, which no base can tighten.
    if (
      put.intent.kind !== "definition.edit" || typeof put.expect !== "object"
    ) {
      return change;
    }
    const base = baseOf(put.key);
    // A record the user never saw has no version to start an edit from.
    if (base === undefined || base === "absent") return change;
    return Object.freeze({
      partition: change.partition,
      put: Object.freeze({ ...put, expect: base }),
    });
  }
  const op = change.op;
  // A delete, and the old key of a rename or a move, removes the version
  // the user started from.
  if (op.kind !== "tombstone" || !REBASED_REMOVALS.has(op.intent.kind)) {
    return change;
  }
  const base = baseOf(op.key);
  // A record the user never saw has no version to delete.
  if (base === undefined || base === "absent") return change;
  return Object.freeze({
    partition: change.partition,
    op: tombstoneOp({ intent: op.intent, key: op.key, expect: base }),
  });
}

async function refusedRecord(
  error: CommitRejectedError,
  partition: PartitionKey,
  options: CommitLogUnitOptions,
): Promise<
  Pick<PartitionRefusal, "key" | "changedBy" | "changedAt">
> {
  if (error.reason !== "expect-failed" || error.key === undefined) return {};
  const key = error.key.toString();
  const reported = error as { changedBy?: unknown; changedAt?: unknown };
  let last: RecordLastChange = {
    ...(typeof reported.changedBy === "string"
      ? { changedBy: reported.changedBy }
      : {}),
    ...(typeof reported.changedAt === "string"
      ? { changedAt: reported.changedAt }
      : {}),
  };
  if (last.changedBy === undefined && options.lastChangeOf !== undefined) {
    try {
      last = await options.lastChangeOf(partition, key);
    } catch (lookupError) {
      logger
        .warn`Looking up who last changed ${key} for a refused commit failed: ${lookupError}`;
    }
  }
  return {
    key,
    ...(last.changedBy === undefined ? {} : { changedBy: last.changedBy }),
    ...(last.changedAt === undefined ? {} : { changedAt: last.changedAt }),
  };
}

/**
 * tombstone intents of a user's edit that expect its base; a key with no base,
 * as a legacy key has none, keeps its expectation
 */
const REBASED_REMOVALS: ReadonlySet<string> = new Set([
  "definition.delete",
  "definition.rename-from",
  "definition.edit",
  "definition.create",
]);

/**
 * a system rewrite (type upgrade, migration) leaves the base, which the user
 * never saw past
 */
function noteCommitted(group: Group, options: CommitLogUnitOptions): void {
  const bases = options.configEditBases;
  if (
    bases === undefined || group.partition.kind !== "config" ||
    !inUserConfigEdit()
  ) {
    return;
  }
  for (const change of group.changes) {
    const key = keyOfChange(change);
    if (key === undefined) continue;
    bases.committed(
      options.namespace.toString(),
      group.partition.toString(),
      key,
    );
  }
}

/**
 * Checks a typed change where it is staged, so a bad one fails at the call
 * that made it rather than at commit.
 */
async function checkChange(change: TypedChange): Promise<TypedChange> {
  if (!(change.partition instanceof PartitionKey)) {
    throw new TypeError("A typed change's partition must be a PartitionKey");
  }
  if ("op" in change) {
    const op = change.op;
    if (!isOp(op)) {
      throw new TypeError(
        "A typed change's op must be built by the op factories",
      );
    }
    if (op.kind === "lease") {
      throw new Error(
        "A lease op is written by the lease machinery, never staged into a " +
          "unit of work",
      );
    }
    if (op.kind === "put" || op.kind === "tombstone") {
      requireSamePartition(intentPartition(op.intent), change.partition);
    }
    if (op.kind === "data-version" && change.partition.kind !== "model") {
      throw new Error(
        `A data-version op belongs in a model partition, not ${change.partition}`,
      );
    }
    return Object.freeze({ partition: change.partition, op });
  }
  const put = change.put;
  const intent = createIntent(put.intent);
  requireSamePartition(intentPartition(intent), change.partition);
  if (!(put.key instanceof RecordKey)) {
    throw new TypeError("A pending put's key must be a RecordKey");
  }
  if (
    !(put.content instanceof Uint8Array) && typeof put.content !== "function"
  ) {
    throw new TypeError(
      "A pending put's content must be bytes or a function returning a stream",
    );
  }
  // Builds the put once with empty content, so a bad key, expect or access
  // fails here rather than blocking the partitions after it at commit.
  await putOp({
    intent,
    key: put.key,
    inline: "",
    ...(put.expect === undefined ? {} : { expect: put.expect }),
    ...(put.access === undefined ? {} : { access: put.access }),
  });
  const frozen: PendingPut = Object.freeze({
    ...put,
    intent,
    // A copy, so a caller reusing its buffer cannot change what commits.
    content: put.content instanceof Uint8Array
      ? new Uint8Array(put.content)
      : put.content,
  });
  return Object.freeze({ partition: change.partition, put: frozen });
}

function requireSamePartition(target: PartitionKey, partition: PartitionKey) {
  if (!target.equals(partition)) {
    throw new Error(
      `A change for partition ${target} was staged for partition ${partition}`,
    );
  }
}

/**
 * a batch never splits, so more than MAX_COMMIT_OPS changes for one partition
 * could never commit
 */
function requireBatchWithinLimit(changes: readonly TypedChange[]): void {
  const counts = new Map<string, number>();
  for (const change of changes) {
    const key = change.partition.toString();
    const count = (counts.get(key) ?? 0) + 1;
    if (count > MAX_COMMIT_OPS) {
      throw new Error(
        `One batch stages more than ${MAX_COMMIT_OPS} changes for partition ` +
          `${key}; a batch commits whole, so stage it as smaller batches`,
      );
    }
    counts.set(key, count);
  }
}

function formGroups(
  batches: readonly (readonly TypedChange[])[],
  formation: number,
  formedAt: number,
): Group[] {
  type Forming = { partition: PartitionKey; changes: TypedChange[] };
  const groups: Forming[] = [];
  const open = new Map<string, Forming>();
  for (const batch of batches) {
    const byPartition = new Map<string, Forming>();
    for (const change of batch) {
      const key = change.partition.toString();
      let part = byPartition.get(key);
      if (part === undefined) {
        part = { partition: change.partition, changes: [] };
        byPartition.set(key, part);
      }
      part.changes.push(change);
    }
    for (const [key, part] of byPartition) {
      let group = open.get(key);
      if (
        group === undefined ||
        group.changes.length + part.changes.length > MAX_COMMIT_OPS
      ) {
        group = { partition: part.partition, changes: [] };
        groups.push(group);
        open.set(key, group);
      }
      for (const change of part.changes) group.changes.push(change);
    }
  }
  return groups.map((group) => ({
    partition: group.partition,
    txnId: crypto.randomUUID(),
    formedAt,
    changes: group.changes,
    formation,
  }));
}

/**
 * only a put or tombstone with no `expect` can supersede an earlier stream put;
 * an `expect` may rely on the earlier put
 */
function supersedingSlot(change: TypedChange): string | undefined {
  if ("put" in change) {
    return change.put.expect === undefined
      ? slotOf(change.partition, change.put.key)
      : undefined;
  }
  const op = change.op;
  if (op.kind !== "put" && op.kind !== "tombstone") return undefined;
  return op.expect === undefined ? slotOf(change.partition, op.key) : undefined;
}

function streamPutSlot(change: TypedChange): string | undefined {
  if (
    !("put" in change) || typeof change.put.content !== "function" ||
    change.put.expect !== undefined
  ) {
    return undefined;
  }
  return slotOf(change.partition, change.put.key);
}

function slotOf(partition: PartitionKey, key: RecordKey): string {
  return `${partition}\u0000${key}`;
}

function recordedVersions(
  group: Group,
): { readonly dataId: string; readonly version: number }[] {
  return group.changes.flatMap((change) =>
    "op" in change && change.op.kind === "data-version"
      ? [{ dataId: change.op.metadata.id, version: change.op.metadata.version }]
      : []
  );
}

function runRank(group: Group): number {
  return group.partition.kind === "run" ? 1 : 0;
}

/**
 * head read and append run under the partition's lock; content is committed in
 * one chunk batch before the commit is prepared, so a power loss never leaves a
 * commit naming a lost chunk. Resolves true when every op was withdrawn
 */
async function appendGroup(
  group: Group,
  options: CommitLogUnitOptions,
  clock: () => Date,
  storedOps: WeakMap<PendingPut, PutOp>,
  superseded: WeakSet<PendingPut>,
  unitOutbox: UnitOutbox,
): Promise<boolean> {
  if (clock().getTime() - group.formedAt > OUTBOX_RETRY_BOUND_MS) {
    // The store may have pruned a landed first attempt's txnId: appending
    // now could land it twice.
    throw new CommitRejectedError(
      "retry-expired",
      `The commit of partition ${group.partition} has been retried for longer ` +
        `than ${OUTBOX_RETRY_BOUND_DAYS} days; it was dropped`,
    );
  }
  const outbox = options.sink.outbox;
  // Read before any content is stored or refreshed: a sweep that starts,
  // deletes and ends before the entry is prepared moves the epoch.
  const sweepBefore = await outbox?.sweepState();
  const ops: Op[] = [];
  const stored: StoredContent[] = [];
  const chunks = options.chunkStore.beginBatch(options.namespace);
  try {
    await storeGroup(
      group,
      options,
      storedOps,
      superseded,
      chunks,
      ops,
      stored,
    );
    if (ops.length === 0) {
      const gone = isWithdrawn(group);
      if (gone) await discardEntries(options, unitOutbox, [group]);
      return gone;
    }
    await chunks.commit(options.signal);
  } catch (error) {
    throw storagePhase(error);
  } finally {
    await chunks.discard();
  }
  let queued = false;
  let withdrawn = false;
  await withPartitionLock(
    options.sink,
    options.namespace,
    group.partition,
    async () => {
      // A seq gap means another writer moved the head between the read and
      // the append; one rebuild at the new head usually lands it.
      for (let attempt = 1;; attempt++) {
        const base = await outbox?.headIdentity(
          options.namespace,
          group.partition,
        );
        const head = base ??
          await options.sink.head(options.namespace, group.partition);
        // Asked on each attempt, since the writer that moved the head may be
        // the owner this group's puts yield to, and after the head read, so
        // an owner landing after this check leaves a seq gap that asks again.
        const kept = opsNotWithdrawn(group, ops, storedOps);
        if (kept.length === 0) {
          withdrawn = true;
          // One that cannot be discarded is warned about. A recovery drops
          // it once the new owner's commit has moved the head, and if that
          // commit missed its deadline the owner's next start commits on top.
          await discardEntries(options, unitOutbox, [group]);
          return;
        }
        if (
          group.expectedSeq !== undefined && head.seq !== group.expectedSeq
        ) {
          throw new StaleSeqError(group.partition, group.expectedSeq, head.seq);
        }
        const commit = Commit.create({
          seq: head.seq + 1,
          partition: group.partition,
          namespace: options.namespace,
          txnId: group.txnId,
          writer: options.writer,
          ...(options.fence === undefined ? {} : { fence: options.fence }),
          ...(group.principal === undefined
            ? {}
            : { principal: group.principal }),
          ...executionOf(options, group),
          at: clock().toISOString(),
          ops: kept,
        });
        if (
          outbox !== undefined && base !== undefined &&
          sweepBefore !== undefined
        ) {
          // Prepared with the head just read, under the partition's lock; a
          // rebuild prepares again with its new base. Tracked first, so a
          // prepare that persisted and then failed is still discarded.
          unitOutbox.prepared.set(
            group.txnId,
            outboxKeyOfGroup(options, group),
          );
          const offline =
            await options.sink.queuesOffline?.(group.partition) === true;
          await outbox.prepare({
            commit,
            unitId: unitOutbox.unitId,
            base,
            ...(offline ? { queuedOffline: true } : {}),
          });
          if (sweepMayOverlap(sweepBefore, await outbox.sweepState())) {
            // a batch in flight may have judged a chunk unreferenced before the
            // prepare and delete it after this check; once re-checked with the
            // entry present, the check holds
            await outbox.sweepBatch?.();
            try {
              await restoreMissingChunks(stored, options);
            } catch (error) {
              throw storagePhase(error);
            }
          }
        }
        unitOutbox.sent.set(group.txnId, group.partition.toString());
        try {
          await options.sink.append(commit);
          return;
        } catch (error) {
          // queued in the outbox while serve is unreachable: the entry stays,
          // marked, for the next command to land, and the unit goes on as if it
          // had landed
          if (
            error instanceof CommitQueuedOfflineError && outbox?.queue &&
            unitOutbox.prepared.has(group.txnId)
          ) {
            const key = unitOutbox.prepared.get(group.txnId)!;
            await outbox.queue([key]);
            unitOutbox.prepared.delete(group.txnId);
            queued = true;
            return;
          }
          if (
            attempt < (options.sink.seqGapAttempts ?? SEQ_GAP_ATTEMPTS) &&
            error instanceof CommitRejectedError && error.reason === "seq-gap"
          ) {
            continue;
          }
          if (await landedDespite(error, group, options, unitOutbox)) return;
          throw error;
        }
      }
    },
  );
  if (withdrawn) return true;
  if (queued) return false;
  // the commit has landed: a failing check is a warning, never a failure that
  // would drop landed work
  try {
    await restoreMissingChunks(stored, options);
  } catch (error) {
    logger
      .warn`A v3 commit to partition ${group.partition.toString()} landed, but checking the content it names failed; reads of that content may fail: ${error}`;
  }
  if (outbox !== undefined) {
    const key = unitOutbox.prepared.get(group.txnId);
    unitOutbox.prepared.delete(group.txnId);
    // A settle that fails costs a duplicate on the next recovery, never the
    // commit, which has landed.
    if (key !== undefined) {
      await outbox.settle([key]).catch((error) =>
        logger
          .debug`Settling the outbox entry of a landed commit failed; the next recovery settles it: ${error}`
      );
    }
  }
  return false;
}

function isWithdrawn(group: Group): boolean {
  return group.changes.some((change) =>
    "put" in change && change.put.withdrawn?.() === true
  );
}

function opsNotWithdrawn(
  group: Group,
  ops: readonly Op[],
  storedOps: WeakMap<PendingPut, PutOp>,
): readonly Op[] {
  const dropped = new Set<Op | undefined>();
  for (const change of group.changes) {
    if ("put" in change && change.put.withdrawn?.()) {
      dropped.add(storedOps.get(change.put));
    }
  }
  return dropped.size === 0 ? ops : ops.filter((op) => !dropped.has(op));
}

/**
 * a retry reuses the content stored the first time, so it never reads a stream
 * twice or reopens a file removed since
 */
async function storeGroup(
  group: Group,
  options: CommitLogUnitOptions,
  storedOps: WeakMap<PendingPut, PutOp>,
  superseded: WeakSet<PendingPut>,
  chunks: ChunkBatch,
  ops: Op[],
  stored: StoredContent[],
): Promise<void> {
  for (const change of group.changes) {
    if ("op" in change) {
      ops.push(change.op);
      continue;
    }
    // Stores nothing for a put that cannot land. The source may hold the new
    // owner's bytes by now, and a failed store would fail a commit with nothing
    // to land. The check under the partition's lock is the one that decides.
    if (change.put.withdrawn?.()) continue;
    let op = storedOps.get(change.put);
    if (op === undefined) {
      if (superseded.has(change.put)) continue;
      try {
        op = await storePut(change.put, options, chunks);
      } catch (error) {
        // Superseded while this group was being stored: its file may be
        // gone, and a later change records what the key ends as.
        if (superseded.has(change.put)) continue;
        throw error;
      }
      storedOps.set(change.put, op);
    } else if ("blob" in op.content) {
      // a retry refreshes what it stored the first time, and stores again what
      // a sweep deleted or a failed barrier never stored, before it prepares
      const missing = await options.chunkStore.refresh(
        options.namespace,
        op.content.blob,
        options.signal,
      );
      if (missing.length > 0) {
        // Superseded since it was stored: its source may be gone, and a
        // later change records what the key ends as, as for a first store.
        if (superseded.has(change.put)) continue;
        await storeAgain(
          change.put.content,
          op.content.blob,
          missing,
          options,
          chunks,
        );
      }
    }
    // Every blob the commit names gets the barrier and the post-commit
    // check, a reused op included: a sweep may have deleted its chunks
    // since they were stored.
    if ("blob" in op.content) {
      chunks.include(op.content.blob.chunkHashes());
      stored.push({ source: change.put.content, blob: op.content.blob });
    }
    ops.push(op);
  }
}

export class CommitQueuedOfflineError extends Error {
  constructor(readonly partition: PartitionKey) {
    super(
      `Serve is unreachable: the commit to ${partition} was queued in the outbox`,
    );
    this.name = "CommitQueuedOfflineError";
  }
}

function executionOf(
  options: CommitLogUnitOptions,
  group: Group,
): { executedAt?: string; clockOffsetMs?: number } {
  if (options.clockOffsetMs === undefined) return {};
  const offset = options.clockOffsetMs();
  return {
    executedAt: new Date(group.formedAt).toISOString(),
    ...(offset !== undefined && Number.isFinite(offset)
      ? { clockOffsetMs: offset }
      : {}),
  };
}

export class StaleSeqError extends Error {
  readonly code = "stale_seq";
  constructor(
    readonly partition: PartitionKey,
    readonly expectedSeq: number,
    readonly seq: number,
  ) {
    super(
      `Partition ${partition} is at seq ${seq}, not ${expectedSeq}: catch up and retry`,
    );
    this.name = "StaleSeqError";
  }
}

export interface ForwardedCommit {
  readonly partition: PartitionKey;
  readonly txnId: string;
  readonly expectedSeq: number;
  readonly principal: string;
  readonly ops: readonly Op[];
}

/**
 * the head is checked against `expectedSeq` under the lock and the content must
 * already be stored; a refused or stale commit is discarded from the outbox
 */
export async function appendForwardedCommit(
  options: CommitLogUnitOptions,
  forwarded: ForwardedCommit,
): Promise<void> {
  const clock = options.clock ?? (() => new Date());
  const group: Group = {
    partition: forwarded.partition,
    txnId: forwarded.txnId,
    formedAt: clock().getTime(),
    changes: forwarded.ops.map((op) => ({
      partition: forwarded.partition,
      op,
    })),
    formation: 0,
    expectedSeq: forwarded.expectedSeq,
    principal: forwarded.principal,
  };
  const unitOutbox: UnitOutbox = {
    unitId: crypto.randomUUID(),
    prepared: new Map(),
    // Never read: a forwarded commit has no tracker to report to.
    sent: new Map(),
  };
  try {
    await appendGroup(
      group,
      options,
      clock,
      new WeakMap(),
      new WeakSet(),
      unitOutbox,
    );
  } catch (error) {
    // A refused or stale commit never lands: give up its entry. Any other
    // failure keeps it, so recovery lands it once and a retry under the
    // same txnId finds it.
    if (
      error instanceof CommitRejectedError || error instanceof StaleSeqError
    ) {
      await discardEntries(options, unitOutbox, [group]);
    }
    throw error;
  }
}

interface UnitOutbox {
  readonly unitId: string;
  readonly prepared: Map<string, OutboxKey>;
  /**
   * noted before the append, since one that fails may still have landed; a
   * dropped unit reports them
   */
  readonly sent: Map<string, string>;
}

function outboxKeyOfGroup(
  options: CommitLogUnitOptions,
  group: Group,
): OutboxKey {
  return {
    namespace: options.namespace,
    partition: group.partition.toString(),
    txnId: group.txnId,
  };
}

/**
 * a writer that took over may have landed the prepared entry; only a prepared
 * group can have, and a landing that cannot be read may have happened
 */
async function landedDespite(
  error: unknown,
  group: Group,
  options: CommitLogUnitOptions,
  unitOutbox: UnitOutbox,
): Promise<boolean> {
  const outbox = options.sink.outbox;
  if (
    outbox?.landedSeq === undefined || !unitOutbox.prepared.has(group.txnId)
  ) {
    return false;
  }
  try {
    return await outbox.landedSeq(
      options.namespace,
      group.partition,
      group.txnId,
    ) !== undefined;
  } catch (readError) {
    throw new MayLandLaterError(error, readError);
  }
}

/**
 * errors met storing or checking content before the append: only one of these
 * can say the storage was unreachable
 */
const storagePhaseErrors = new WeakSet<object>();

function storagePhase(error: unknown): unknown {
  if (typeof error === "object" && error !== null) {
    storagePhaseErrors.add(error);
  }
  return error;
}

export function failedReachingStorage(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    storagePhaseErrors.has(error) && isNetworkFailure(error);
}

/**
 * each entry is marked abandoned, fsynced, then removed; a failed removal is
 * retried at close and recovery drops a marked entry meanwhile; resolves with
 * the reason when neither could be written
 */
async function discardEntries(
  options: CommitLogUnitOptions,
  unitOutbox: UnitOutbox,
  groups: readonly Group[],
): Promise<{ readonly reason: unknown } | undefined> {
  const outbox = options.sink.outbox;
  if (outbox === undefined) return undefined;
  const keys: OutboxKey[] = [];
  for (const group of groups) {
    const key = unitOutbox.prepared.get(group.txnId);
    if (key === undefined) continue;
    unitOutbox.prepared.delete(group.txnId);
    keys.push(key);
  }
  if (keys.length === 0) return undefined;
  let marked = false;
  if (outbox.abandon !== undefined) {
    try {
      await outbox.abandon(keys);
      marked = true;
    } catch (error) {
      logger
        .debug`Marking ${keys.length} outbox entries of failed v3 commits abandoned failed: ${error}`;
    }
  }
  try {
    await outbox.discard(keys);
    return undefined;
  } catch (error) {
    if (marked) {
      logger
        .warn`Discarding ${keys.length} outbox entries of failed v3 commits failed; they are marked abandoned, so no recovery lands them, and are discarded again when the datastore closes: ${error}`;
      return undefined;
    }
    logger
      .warn`Discarding ${keys.length} outbox entries of failed v3 commits failed, and so did marking them abandoned; a later swamp command may commit them: ${error}`;
    return { reason: error };
  }
}

interface StoredContent {
  readonly source: ContentSource;
  readonly blob: BlobRef;
}

/**
 * a sweep can delete a chunk after its commit landed; any missing chunk is
 * stored again from the put's source, which must give the same reference. One
 * blob's failure does not cost the others
 */
async function restoreMissingChunks(
  stored: readonly StoredContent[],
  options: CommitLogUnitOptions,
): Promise<void> {
  const { chunkStore, namespace, signal } = options;
  const chunks = chunkStore.beginBatch(namespace);
  const errors: unknown[] = [];
  try {
    let restored = false;
    for (const content of stored) {
      signal?.throwIfAborted();
      try {
        const missing = await chunkStore.missing(
          namespace,
          content.blob,
          signal,
        );
        if (missing.length === 0) continue;
        restored = true;
        await storeAgain(
          content.source,
          content.blob,
          missing,
          options,
          chunks,
        );
        chunks.include(content.blob.chunkHashes());
      } catch (error) {
        // An abort ends the check: it is not one blob's failure.
        signal?.throwIfAborted();
        errors.push(error);
      }
    }
    // Chunks staged for a blob that then failed are committed too: no
    // commit names them, so they are as harmless as any unreferenced chunk.
    if (restored) {
      try {
        await chunks.commit(signal);
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    await chunks.discard();
  }
  signal?.throwIfAborted();
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Storing the content of a landed v3 commit again failed ${errors.length} times; the first: ${
        errors[0]
      }`,
    );
  }
}

async function storeAgain(
  source: ContentSource,
  blob: BlobRef,
  missing: readonly string[],
  options: CommitLogUnitOptions,
  chunks: ChunkBatch,
): Promise<void> {
  const { chunkStore, namespace, signal } = options;
  const again = await chunkStore.write(
    namespace,
    source instanceof Uint8Array ? source : await source(),
    signal,
    chunks,
  );
  if (!again.equals(blob)) {
    throw new Error(
      `A commit names chunk ${
        missing[0]
      }, which is missing, and its content source no longer gives content ${blob.sha256}`,
    );
  }
}

const SEQ_GAP_ATTEMPTS = 2;

async function storePut(
  put: PendingPut,
  options: CommitLogUnitOptions,
  chunks: ChunkBatch,
): Promise<PutOp> {
  const content = await storeContent(put.content, options, chunks);
  return await putOp({
    intent: put.intent,
    key: put.key,
    ...content,
    ...(put.expect === undefined ? {} : { expect: put.expect }),
    ...(put.access === undefined ? {} : { access: put.access }),
  });
}

async function storeContent(
  source: ContentSource,
  options: CommitLogUnitOptions,
  chunks: ChunkBatch,
): Promise<{ inline: string } | { blob: BlobRef }> {
  const { chunkStore, namespace, signal } = options;
  signal.throwIfAborted();
  if (source instanceof Uint8Array) {
    return source.length <= MAX_INLINE_BYTES
      ? { inline: toBase64(source) }
      : { blob: await chunkStore.write(namespace, source, signal, chunks) };
  }
  const reader = (await source()).getReader();
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let handedOn = false;
  try {
    while (headBytes <= MAX_INLINE_BYTES) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return { inline: toBase64(concat(head, headBytes)) };
      head.push(value);
      headBytes += value.length;
    }
    // The chunk store now owns the stream: it cancels it, and so the
    // source, when the write fails or aborts.
    handedOn = true;
    return {
      blob: await chunkStore.write(
        namespace,
        resume(head, reader),
        signal,
        chunks,
      ),
    };
  } finally {
    if (!handedOn) await reader.cancel().catch(() => {});
  }
}

/**
 * A stream of the pieces already read followed by the rest of `reader`.
 * Cancelling it cancels the source.
 */
function resume(
  pieces: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next < pieces.length) {
        controller.enqueue(pieces[next++]);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 });
}

function concat(pieces: readonly Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  return joined;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The tail of each partition's append queue, by sink. Entries are removed
 * when their queue drains, so the map holds only partitions being appended.
 */
const partitionLocks = new WeakMap<CommitSink, Map<string, Promise<void>>>();

async function withPartitionLock(
  sink: CommitSink,
  namespace: string,
  partition: PartitionKey,
  fn: () => Promise<void>,
): Promise<void> {
  let queues = partitionLocks.get(sink);
  if (queues === undefined) {
    queues = new Map();
    partitionLocks.set(sink, queues);
  }
  const key = `${namespace}\u0000${partition}`;
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  try {
    await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

export function partitionLockCountForTesting(sink: CommitSink): number {
  return partitionLocks.get(sink)?.size ?? 0;
}
