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
 * The commit-log unit of work: datastore rework Phase 3 (swamp-club#3240).
 *
 * A unit stages typed changes and, when it commits, turns them into one
 * commit per partition. Dormant: nothing outside the v3 directories imports
 * it (`integration/datastore_v3_rules_test.ts`); tests open it through
 * `runInCommitLogRoot` until the v3 opt-in wires it in.
 *
 * **Commit order and failure (decisions 4, 6 and 7 of "v3 domain model",
 * `design/enablers/datastores.md`).** Each partition commits on its own, in
 * the order its first change was staged, with workflow-run partitions last,
 * so a run record never names data that has not landed. For each partition
 * the unit stores the content that needs storing (chunks before the commit
 * that names them), then appends one commit through the {@link CommitSink}.
 * There is no atomicity across partitions: when a partition fails, the
 * partitions before it stay committed and the ones after it are not tried;
 * a refusal is the exception (below).
 *
 * - A partition whose commit failed stays **pending** with its txnId and
 *   ops. The next `checkpoint` of the same unit, or its `commit`, rebuilds
 *   its commit at the partition's current head with the same txnId, so a
 *   commit that did land the first time is reported `duplicate` by the store
 *   and lands once. `commit` ends the unit whether or not it succeeds (the
 *   `UnitOfWork` contract), so what is still pending when the unit's own
 *   commit fails is reported failed and dropped with it. A caller that must
 *   retry checkpoints first. A retry older than `OUTBOX_RETRY_BOUND_MS` is
 *   refused (`retry-expired`) rather than appended.
 * - A refusal (`CommitRejectedError`) drops the refused partition's
 *   changes: they can never land as they are, and keeping them would block
 *   every partition staged after them. The flush goes on to the other
 *   partitions, then throws one {@link PartitionsRefusedError} carrying each
 *   refusal (swamp-club#3257). A `seq-gap` is not a refusal: another append
 *   moved the head first, so the append is rebuilt at the new head once more
 *   in the same flush, and if that also meets a gap the partition stays
 *   pending and the flush stops.
 * - `abandon` discards staged and pending changes. A checkpoint already in
 *   progress finishes first, so what it commits stays committed. Chunks
 *   already stored stay unreferenced until chunk garbage collection
 *   reclaims them.
 * - Run partitions commit after the others of the same flush, and a run
 *   record never names data whose partition was refused (decision 7,
 *   swamp-club#3257): once a non-run partition is refused, every run
 *   partition stays pending, never dropped, for the rest of the unit's life,
 *   since a run's record is rewritten whole on each save and a later save
 *   still names what an earlier flush refused. `acknowledgeRefusals`
 *   releases them after the caller saved each affected run again; that save
 *   supersedes the held record, and the run's snapshot commits with it. A
 *   root that ends without acknowledging throws the refusal again, and its
 *   held run records are lost with it.
 *
 * **Batches, splits and elision (swamp-club#3250).** `stageOps` records a
 * batch all or nothing, and a child hands its batches to its ancestor one by
 * one. When a flush forms groups, a partition holding more than
 * `MAX_COMMIT_OPS` changes splits into several groups, each one commit,
 * between batches, so one batch always lands in one commit; a single batch
 * over the limit is refused when it is staged. A refused split drops the
 * splits of its partition formed in the same flush, which were staged after
 * it; a batch staged later forms its own group. Before a stream put is read,
 * the unit drops it when a later put or tombstone of its key with no
 * `expect` supersedes it, among the unflushed batches and the pending
 * groups not being appended whose put is not stored yet; a group emptied so
 * is dropped. A stored put's op is kept, so a retry never reads the stream
 * again. The exceptions are repair after a chunk GC race: a retry that
 * reuses a kept op refreshes its chunks first, and every landed commit runs
 * the post-commit check ({@link restoreMissingChunks}); each reads the source
 * again only when one of the commit's chunks is actually missing; a kept
 * op whose put was superseded since is skipped instead, as an unstored one
 * is. A superseded put that was dropped never commits, so it needs no check.
 *
 * **The outbox (swamp-club#3490).** The unit appends through a
 * {@link CommitSink}. A sink with an {@link SinkOutbox} (a v3 datastore's)
 * makes each commit durable across a crash: under the partition's lock,
 * the unit prepares the commit with the head it was built on, then appends
 * it, checks its chunks and settles the entry. A process that dies in
 * between leaves the entry for the next writer to land
 * (`commit_outbox_recovery.ts`). A refusal gives up the refused entry and
 * every run entry of the unit (decision 7); a unit that ends with a commit
 * still failing gives up its entries, since the failure was reported. Giving
 * up marks an entry abandoned, then discards it; a unit that can write
 * neither fails with `MayLandLaterError` (swamp-club#3586). An append that
 * fails is checked against the store: a commit a writer that took over
 * landed counts as appended, and once an append returns, a failing check
 * after it is a warning. A sink without an outbox, the bare `CommitStore`
 * tests pass, prepares nothing. Before preparing, and after, the unit reads
 * the sweep state; when a chunk sweep may have overlapped
 * (`sweepMayOverlap`) it waits for the sweep's batch in flight, then checks
 * its chunks before the append too, so no landed commit names a chunk a
 * sweep deleted even when the writer dies before its post-commit check.
 *
 * **Root and child units.** A unit opened with an open commit-log unit for
 * the same hook as `parent` is its child. A child keeps its changes to
 * itself: its `commit` hands them, in order, to its nearest open ancestor,
 * and its `abandon` discards them. A change staged after the child committed
 * goes to that ancestor; one staged after it was abandoned is refused. Only
 * a root commits to the log, and
 * `checkpoint` on a child throws. A root's checkpoint commits what has been
 * handed to it so far; a child still open keeps its changes until it ends,
 * or until {@link checkpointFrom} hands them over (swamp-club#3587).
 *
 * @module
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
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  typedStagers,
  unitOfWorkBinding,
  unitWrites,
  versionFloors,
  type VersionFloorSource,
} from "../persistence/unit_of_work_binding.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { isNetworkFailure } from "./network_failure.ts";

const logger = getSwampLogger(["datastore", "v3"]);

/**
 * Where a commit-log unit appends its commits: the outbox seam. A bare
 * `CommitStore` appends directly; a v3 datastore's sink also carries the
 * outbox. `head` gives the seq the next commit takes.
 */
export type CommitSink = Pick<CommitStore, "append" | "head"> & {
  /** A data name's high-water mark in its partition (swamp-club#3532). */
  readonly dataHighWater?: (
    namespace: string,
    partition: PartitionKey,
    name: string,
  ) => Promise<number>;
  /** Makes each commit durable until it has landed (swamp-club#3490). */
  readonly outbox?: SinkOutbox;
  /**
   * How many times one flush tries a partition's append through seq gaps;
   * 2 when absent. Serve's sink catches up and retries a stale seq, which
   * other writers can move more than once (swamp-club#3985).
   */
  readonly seqGapAttempts?: number;
};

/**
 * The greatest version each data name was given in this process, by sink,
 * then namespace, partition and name (swamp-club#3532). It covers versions
 * staged but not committed yet, which the commit store cannot see: in the
 * same unit, a sibling unit, or a deferred write. One number per name a
 * process writes, so it is never evicted.
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

/** What a {@link CommitSink} offers a unit to keep its commits durable. */
export interface SinkOutbox {
  /** The partition's head and the txnId of its head commit. */
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
   * Marks entries the unit gave up, fsynced, before they are discarded
   * (swamp-club#3586): recovery never lands a marked entry.
   */
  abandon?(keys: readonly OutboxKey[]): Promise<void>;
  /**
   * The seq a txnId landed at, if it did: read after an append fails, since
   * a writer that took over may have landed the prepared commit.
   */
  landedSeq?(
    namespace: string,
    partition: PartitionKey,
    txnId: string,
  ): Promise<number | undefined>;
  /** The chunk sweep's state now. */
  sweepState(): Promise<SweepState>;
  /**
   * Resolves once the chunk sweep batch this process is running, if any,
   * has deleted its chunks and re-checked their references.
   */
  sweepBatch?(): Promise<void>;
}

/** What a commit-log unit needs to commit. */
export interface CommitLogUnitOptions {
  readonly sink: CommitSink;
  /** Stores content too large to inline. */
  readonly chunkStore: ChunkStore;
  /** The datastore namespace; empty for an unnamespaced datastore. */
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
  /** The clock a commit's `at` is read from; the system clock by default. */
  readonly clock?: () => Date;
  /**
   * The unit that was ambient when this one opened. The new unit is its
   * child when it is an open commit-log unit for the same hook, or the
   * child of its nearest open ancestor when it has ended; otherwise a root.
   */
  readonly parent?: UnitOfWork;
  /**
   * Whether a change to a record key belongs to the datastore: false for a
   * key the repository's configured `directories` leave out or its
   * `exclude` patterns match, which stays in the checkout and is never
   * committed (swamp-club#3279). Every key belongs when absent.
   */
  readonly admits?: (key: string) => boolean;
  /**
   * Told when the unit opens and ends, and when it drops work a repository
   * may already have written to the checkout (swamp-club#3553).
   */
  readonly tracker?: UnitTracker;
}

/**
 * What the v3 handle learns from each unit it opens (swamp-club#3553): its
 * open units, and the dropped work its checkout may still hold.
 */
export interface UnitTracker {
  opened(): void;
  ended(): void;
  /**
   * A unit a repository wrote into dropped work: a refused commit, an
   * abandon, a failed end, or a write refused after its files were written.
   * `openedAt` is its root's open time, epoch milliseconds: nothing it
   * wrote is older. `versionDirs` are the keys of the data version
   * directories it created (swamp-club#3736): whatever is left in them is
   * its work, however old the files' mtimes.
   */
  dropped(openedAt: number, versionDirs: readonly string[]): void;
}

/** A path-only change staged into a commit-log unit, which takes typed ones. */
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

/** One partition's changes on their way to a single commit. */
interface Group {
  readonly partition: PartitionKey;
  /** Fixed when the group forms, so a retry of its commit lands once. */
  readonly txnId: string;
  /** When it formed, epoch milliseconds: a retry past the bound is refused. */
  readonly formedAt: number;
  readonly changes: readonly TypedChange[];
  /**
   * The flush that formed it. A partition's changes split into several
   * groups when they pass MAX_COMMIT_OPS; the splits formed together share
   * this, so a refusal of one drops the splits after it.
   */
  readonly formation: number;
  /**
   * A forwarded commit's (swamp-club#3915): the head its client built on.
   * The commit is refused rather than rebuilt when the head has moved.
   */
  readonly expectedSeq?: number;
  /** A forwarded commit's caller, stamped by serve. */
  readonly principal?: string;
}

/** What a commit-log unit exposes to its children. Adapter-private. */
interface CommitLogState {
  readonly hook: MarkDirtyHook;
  isOpen(): boolean;
  readonly parent: UnitOfWork | undefined;
  /** When the unit's root opened, epoch milliseconds. */
  readonly openedAt: number;
  /** Takes a committed child's batches, in order and batch by batch. */
  adopt(
    batches: readonly (readonly TypedChange[])[],
    versionDirs?: readonly string[],
  ): void;
  /**
   * Hands what the unit has staged so far to its nearest open ancestor and
   * stays open (swamp-club#3587); a no-op on an ended unit.
   */
  promote(): void;
  /**
   * Skips this unit's queued stream puts that `change`, staged in a
   * descendant that promoted, supersedes; see {@link checkpointFrom}.
   */
  skipSuperseded(change: TypedChange): void;
}

const states = new WeakMap<UnitOfWork, CommitLogState>();

/**
 * The open commit-log unit a new unit over `markDirty` rolls up into, given
 * the ambient unit `candidate`: `candidate` when it is an open commit-log
 * unit for that hook, otherwise its nearest open ancestor; undefined when
 * there is none, so the new unit is a root.
 */
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
 * Commits, mid-operation, what `unit` and each open ancestor have staged so
 * far (swamp-club#3587): each open unit from `unit` up hands its batches to
 * its nearest open ancestor and stays open, then the root checkpoints. An
 * ended unit has nothing left to hand over, so the walk goes on from its
 * nearest open ancestor. Resolves false, committing nothing, when `unit` is
 * not a commit-log unit or its root has ended.
 *
 * What is handed over belongs to the root from then on: a later abandon of
 * the unit discards only what it staged after. A put or tombstone the unit
 * stages afterwards still supersedes a handed-over stream put that has not
 * been read, which is skipped rather than read from a file that may have
 * changed; should the unit then be abandoned, neither version of that key
 * lands, as a crash then would leave neither.
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

/**
 * Builds a commit-log unit over `markDirty`, the hook of the v3 repository
 * context it serves, and binds it to that hook. See the module doc for what
 * commit, checkpoint and abandon do.
 */
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
   * Whether a repository wrote into this unit: a write signal, or any
   * change it recorded, a committed child's included. Only such a unit's
   * dropped work can be in the checkout (swamp-club#3553).
   */
  let touched = false;
  /**
   * The data version directories this unit created, and those of the
   * children that committed into it (swamp-club#3736).
   */
  let versionDirs: string[] = [];
  const dropWork = (): void => {
    if (!touched) return;
    try {
      options.tracker?.dropped(openedAt, versionDirs);
    } catch (error) {
      logger
        .warn`Recording the work a v3 unit of work dropped failed: ${error}`;
    }
  };
  /** Every change staged, for `stagedOps`. */
  const all: TypedChange[] = [];
  /**
   * Batches not yet formed into groups, in staging order. A batch is the
   * changes one `stageOps` call recorded; groups split only between them.
   */
  let staged: TypedChange[][] = [];
  /** Groups formed but not yet confirmed by the sink, in commit order. */
  let pending: Group[] = [];
  /**
   * The partitions whose commits landed over the unit's life, checkpoints'
   * included, so a failed end can say what was committed (swamp-club#3802).
   */
  const landed: PartitionKey[] = [];
  /** The group whose commit is being built or appended, if any. */
  let inFlight: Group | undefined;
  /** Each pending put's op once its content is stored, for retries. */
  const stored = new WeakMap<PendingPut, PutOp>();
  /**
   * Stream puts of pending groups that a later change superseded but that
   * stay in their group: unstored ones of the group being appended, which
   * cannot change under its append, and stored ones, whose op is kept. A
   * group skips an unstored one when it reaches it, and a stored one when a
   * retry finds its chunks missing, instead of reading its source again.
   */
  const supersededInFlight = new WeakSet<PendingPut>();
  /** The unflushed stream puts by partition and key, where they sit. */
  const streamPuts = new Map<
    string,
    { readonly batch: TypedChange[]; readonly change: TypedChange }
  >();
  let formations = 0;
  let ended: "committed" | "abandoned" | undefined;
  /**
   * The non-run partitions refused since the last acknowledgement: while
   * any is, run partitions stay pending (decision 7).
   */
  let refusals: PartitionRefusal[] = [];
  /** Serializes this unit's commits and checkpoints. */
  let flushing: Promise<void> = Promise.resolve();
  /**
   * A refusal whose entries could be neither discarded nor marked abandoned
   * (swamp-club#3586): the unit's end says its changes may still land.
   */
  let unconfirmed:
    | { readonly cause: unknown; readonly reason: unknown }
    | undefined;
  /** The unit's outbox entries not yet settled, by txnId. */
  const outbox: UnitOutbox = {
    unitId: crypto.randomUUID(),
    prepared: new Map(),
  };

  /**
   * Drops a stream put that `change` supersedes before its stream is read:
   * a later put or tombstone of the same key leaves the same record, and the
   * file behind the stream may be gone by commit (a prune, a delete or an
   * in-place append after a save). Covers the unflushed batches and the
   * pending groups not in flight whose put is not stored yet.
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
   * Marks the queued stream puts `change` supersedes to be skipped when
   * their group is appended, without removing them: `change` is still a
   * descendant's, which may yet be abandoned. Unformed batches need nothing,
   * since the next flush promotes `change` first and elides them then.
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

  /** Records one batch: refused whole when a partition passes the limit. */
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
        try {
          await appendGroup(
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
          // Decision 7 across a crash: with the refused entries go the
          // unit's run entries, so a recovery never lands a run record that
          // names what was refused.
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
            versions: dropped.flatMap((other) => recordedVersions(other)),
          };
          refusedNow.push(refusal);
          if (runRank(group) === 0) refusals = [...refusals, refusal];
          dropWork();
          continue;
        } finally {
          inFlight = undefined;
        }
        pending = pending.filter((other) => other !== group);
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

  /**
   * The refusal a flush throws: every unacknowledged non-run refusal (this
   * flush's and earlier ones, which `acknowledgeRefusals` clears together),
   * this flush's run refusals, and the run partitions held back.
   */
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
    // Told only once the final flush and its discards are done: a recovery
    // of dropped work waits for every open unit (swamp-club#3586).
    try {
      await finish(as);
    } finally {
      options.tracker?.ended();
    }
  };

  /** A refusal's lost discard, as the unit's end reports it. */
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
      // The unit ends with these commits failed, and the caller is told so:
      // a later recovery must not land them. When that cannot be recorded,
      // the caller is told they may land (swamp-club#3586).
      dropWork();
      const lost = await discardEntries(options, outbox, pending) ??
        unconfirmed;
      if (lost !== undefined && !(error instanceof MayLandLaterError)) {
        throw new MayLandLaterError(error, lost.reason);
      }
      // Given up, so nothing of it can land: a commit that never reached
      // the storage says so, and a retry is safe (swamp-club#3759). A run
      // whose checkpoint landed is left running instead (swamp-club#3802).
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
        checked.push(await checkChange(change));
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

/** The record key a typed change writes, when it writes one. */
function keyOfChange(change: TypedChange): string | undefined {
  if ("put" in change) return change.put.key.toString();
  const op = change.op;
  return "key" in op ? op.key.toString() : undefined;
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
 * Refuses a batch holding more than MAX_COMMIT_OPS changes for one
 * partition: a batch never splits, so it could never commit.
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

/**
 * Groups batches by partition, in the order each was first touched. A
 * partition's group splits before a batch that would take it past
 * MAX_COMMIT_OPS, so each split is one commit and no batch spans two.
 */
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
 * The partition and key a change writes when it can supersede an earlier
 * stream put: a put or tombstone carrying no `expect` (an `expect` may rely
 * on the earlier put).
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

/** The slot of a pending put whose content is a stream, with no `expect`. */
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

/** The data versions a group's `data-version` ops record. */
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
 * Stores the group's content, then appends its commit at the partition's
 * current head. The head read and the append run under the partition's
 * lock, so two units in one process never take the same seq. Once the
 * commit has landed, any of its chunks that chunk garbage collection
 * deleted meanwhile are stored again (see {@link restoreMissingChunks}).
 *
 * The chunk barrier (swamp-club#3617): the group's content goes into one
 * {@link ChunkBatch}, committed before the commit is prepared or appended.
 * Its new chunks are synced together, then renamed into place, and every
 * chunk the commit names, stored now or found present, has its name made
 * durable, so a power loss never leaves a commit naming a chunk whose bytes
 * or rename were lost. Chunks stored again later get a batch of their own.
 */
async function appendGroup(
  group: Group,
  options: CommitLogUnitOptions,
  clock: () => Date,
  storedOps: WeakMap<PendingPut, PutOp>,
  superseded: WeakSet<PendingPut>,
  unitOutbox: UnitOutbox,
): Promise<void> {
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
    // Every op was a superseded put: nothing to commit.
    if (ops.length === 0) return;
    // A failed barrier fails the group as a failed store does: nothing is
    // prepared or appended.
    await chunks.commit(options.signal);
  } catch (error) {
    throw storagePhase(error);
  } finally {
    await chunks.discard();
  }
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
          at: clock().toISOString(),
          ops,
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
          await outbox.prepare({ commit, unitId: unitOutbox.unitId, base });
          if (sweepMayOverlap(sweepBefore, await outbox.sweepState())) {
            // A batch in flight may have judged a chunk unreferenced before
            // the prepare and delete it after this check: once it has
            // re-checked, with the entry present, the check holds
            // (swamp-club#3586). A batch that starts later sees the entry.
            await outbox.sweepBatch?.();
            try {
              await restoreMissingChunks(stored, options);
            } catch (error) {
              throw storagePhase(error);
            }
          }
        }
        try {
          await options.sink.append(commit);
          return;
        } catch (error) {
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
  // The commit has landed: a failing check is a warning, never a failure
  // that would drop landed work (swamp-club#3586).
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
}

/**
 * Stores the group's content into `chunks` and collects its ops in `ops`,
 * and the blobs they name in `stored`. A retry reuses the content stored
 * the first time, so it never reads a stream twice or reopens a file
 * removed since.
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
      // A retry refreshes what it stored the first time, and stores again
      // what a sweep deleted, or a failed barrier never stored, before it
      // prepares (swamp-club#3586).
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

/** A unit's outbox bookkeeping. */
/**
 * A forwarded commit built on a head that has moved (swamp-club#3915): its
 * client catches up and builds it again.
 */
export class StaleSeqError extends Error {
  readonly code = "stale_seq";
  constructor(
    readonly partition: PartitionKey,
    readonly expectedSeq: number,
    /** The partition's head now. */
    readonly seq: number,
  ) {
    super(
      `Partition ${partition} is at seq ${seq}, not ${expectedSeq}: catch up and retry`,
    );
    this.name = "StaleSeqError";
  }
}

/** A commit a client built, for serve to append (swamp-club#3915). */
export interface ForwardedCommit {
  readonly partition: PartitionKey;
  /** The client's id for the commit; a retry carries the same one. */
  readonly txnId: string;
  /** The head the client built on: the commit lands at the next seq. */
  readonly expectedSeq: number;
  /** The authenticated caller. */
  readonly principal: string;
  readonly ops: readonly Op[];
}

/**
 * Appends a forwarded commit through the same path a unit's commits take:
 * the partition's lock, the outbox prepare, the append and its settle, with
 * the writer, fence and namespace of `options`, never the client's. The
 * head is checked against `expectedSeq` under the lock. Its content must
 * already be stored. Resolves once the commit has landed; a commit refused
 * or stale is discarded from the outbox.
 *
 * @throws StaleSeqError when the partition's head is not `expectedSeq`
 * @throws CommitRejectedError when the partition refuses the commit
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
  /** Entries prepared and not settled, by the group's txnId. */
  readonly prepared: Map<string, OutboxKey>;
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
 * Whether the group's commit landed although its append failed
 * (swamp-club#3586): a writer that took over may have landed the prepared
 * entry, or the append may have failed after its commit. Only a prepared
 * group can have; a landing that cannot be read may have happened.
 *
 * @throws MayLandLaterError when the store cannot say
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
 * The errors a commit met storing or checking its content before its append
 * (swamp-club#3759): only one of these can say the storage was unreachable.
 */
const storagePhaseErrors = new WeakSet<object>();

/** Records that `error` came from storing a commit's content; returns it. */
function storagePhase(error: unknown): unknown {
  if (typeof error === "object" && error !== null) {
    storagePhaseErrors.add(error);
  }
  return error;
}

/**
 * Whether a commit failed because it could not reach the storage before its
 * append: a storage call that met a network failure.
 */
export function failedReachingStorage(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    storagePhaseErrors.has(error) && isNetworkFailure(error);
}

/**
 * Gives up the outbox entries of `groups` that the unit prepared: a refusal,
 * an abandon or a failed end (swamp-club#3586). Each is marked abandoned,
 * fsynced, then removed; a removal that fails is retried when the datastore
 * closes, and recovery drops a marked entry meanwhile. Resolves with the
 * reason when neither could be written: then a recovery may land them.
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

/** Content a landed commit names as chunks, and where it came from. */
interface StoredContent {
  readonly source: ContentSource;
  readonly blob: BlobRef;
}

/**
 * The writer's half of closing chunk garbage collection's race
 * (swamp-club#3249). A sweep can delete a chunk this unit found present
 * and refreshed before its commit landed; the sweep re-checks references
 * after deleting and restores what a commit landed on meanwhile, so what is
 * left is a commit landing after that re-check. Checked here, after the
 * commit has landed (appended or a duplicate), any chunk of it missing is
 * stored again from the put's content source, which stays readable until
 * the unit ends. Content stored again must give the same reference; a
 * source that changed cannot repair the commit, and the caller reports it
 * as a warning, since the commit has landed (swamp-club#3586). What is
 * stored again goes into one {@link ChunkBatch}, committed before this
 * returns: the chunk barrier (swamp-club#3617). One blob that cannot be
 * stored again does not cost the others: the batch still commits what was
 * staged, then the first failure is thrown (an `AggregateError` for more
 * than one). An abort of `options.signal` ends the check and is thrown as
 * itself, never wrapped as one blob's failure.
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

/**
 * Stores `blob`'s content again from `source`, of which `missing` chunks are
 * gone. Content stored again must give the same reference.
 */
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

/** How many times one flush tries a partition's append through seq gaps. */
const SEQ_GAP_ATTEMPTS = 2;

/** Builds a pending put's op, storing its content inline or as chunks. */
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

/**
 * Inlines content of at most {@link MAX_INLINE_BYTES}, and stores anything
 * longer through the chunk store, into `chunks`. A stream source is read, a
 * piece at a time, until it ends or holds more than the inline limit; what
 * was read is then handed to the chunk store ahead of the rest.
 */
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

/** Canonical base64, as `putOp` requires of inline content. */
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

/**
 * Runs `fn` after every earlier append to the same partition of the same
 * sink has settled. The lock is released whether `fn` resolves or throws.
 */
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

/** How many partitions of a sink have an append queued or running; for tests. */
export function partitionLockCountForTesting(sink: CommitSink): number {
  return partitionLocks.get(sink)?.size ?? 0;
}
