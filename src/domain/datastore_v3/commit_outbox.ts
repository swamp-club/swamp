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
 * The commit outbox (swamp-club#3490, datastore rework Phase 4 F): where a
 * writer keeps each commit it is about to append, durably on its own
 * machine, so a process that dies between preparing a commit and settling
 * it leaves the commit for the next writer to land, once.
 *
 * - **Lifecycle.** A unit prepares a group's commit just before appending
 *   it, under the partition's lock, with the partition head it was built on
 *   (its base). It settles the entry once the commit has landed and passed
 *   the post-commit chunk check. A refusal, an abandon or a unit that ends
 *   with the commit still failing discards it: that failure was reported.
 *   Only a process that dies leaves entries.
 * - **Recovery** runs under the next writer hold of the same copy of
 *   `commits.db`. An entry lands only when its txnId is already stored (it
 *   settles as a duplicate) or the partition head still is its base, under
 *   the current writer's fence. Everything else is dropped and reported.
 * - **Fences.** Every CLI write takes a new fence, so an entry's own fence
 *   is always below its recoverer's. The copy records the fences it took as
 *   a chain, by the rule replication lineages use: a fence one above the
 *   last continues it, anything else restarts it. An entry from before the
 *   chain's start was prepared before another copy took the lease, and is
 *   dropped. The floor is the fence of the last completed recovery: an entry
 *   below it was prepared by a writer that lost its lease after its
 *   successor recovered, and is dropped too.
 * - **Retry age.** An entry older than {@link OUTBOX_RETRY_BOUND_MS} is
 *   dropped, and no retry, in memory or from the outbox, is appended past
 *   it. `compacted_txns` keeps a compacted commit's txnId for
 *   {@link COMPACTED_TXN_RETENTION_MS}, longer than the bound, so every
 *   retry inside it still finds its txnId and lands once.
 *
 * Pure rules and the port; `SqliteCommitOutbox` is the adapter. See "v3
 * commit outbox" in `design/enablers/datastores.md`.
 *
 * @module
 */

import type { Commit, CommitWriter } from "./commit.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How old an outbox entry, or a unit's in-memory retry, may get before it is
 * dropped rather than appended: days, so a machine that was off over a long
 * weekend still lands what it prepared.
 */
export const OUTBOX_RETRY_BOUND_MS = 7 * DAY_MS;

/**
 * How long `compacted_txns` keeps a compacted commit's txnId. Longer than
 * {@link OUTBOX_RETRY_BOUND_MS} by a day of slack, more than any clock skew
 * between the writer that built a commit and the one compacting it, so a
 * retry inside the bound never finds its txnId pruned.
 */
export const COMPACTED_TXN_RETENTION_MS = OUTBOX_RETRY_BOUND_MS + DAY_MS;

/**
 * How long a sweep's heartbeat keeps it counting as in progress. The sweeper
 * renews it every batch; one killed mid-sweep stops counting after this.
 */
export const OUTBOX_SWEEP_STALE_MS = 15 * 60 * 1000;

/**
 * A partition head: its seq, and the txnId of the commit at that seq. The
 * txnId is undefined at seq 0, and when the store keeps only the seq (the
 * head commit was compacted and its txnId pruned).
 */
export interface HeadIdentity {
  readonly seq: number;
  readonly txnId: string | undefined;
}

/**
 * Whether `current` is still the head `base` named. A txnId that either
 * side lacks is not compared: the store then knows only the seq, which a
 * restore can never take below the compaction point.
 */
export function sameHead(base: HeadIdentity, current: HeadIdentity): boolean {
  if (base.seq !== current.seq) return false;
  if (base.txnId === undefined || current.txnId === undefined) return true;
  return base.txnId === current.txnId;
}

/** What identifies an entry: its commit's namespace, partition and txnId. */
export interface OutboxKey {
  readonly namespace: string;
  readonly partition: string;
  readonly txnId: string;
}

/** The key of a commit's entry. */
export function outboxKeyOf(commit: Commit): OutboxKey {
  return {
    namespace: commit.namespace,
    partition: commit.partition.toString(),
    txnId: commit.txnId,
  };
}

/** What a unit prepares. */
export interface OutboxPreparation {
  /**
   * The commit as it is about to be appended: its ops, writer and fence. A
   * recovery rebuilds it at the head it finds, under its own fence.
   */
  readonly commit: Commit;
  /** The unit that prepared it, so a refusal drops its run entries. */
  readonly unitId: string;
  /** The partition head the commit was built on. */
  readonly base: HeadIdentity;
}

/** One prepared commit, as the outbox holds it. */
export interface OutboxEntry extends OutboxPreparation {
  /**
   * The outbox's own order of first preparation. Recovery lands entries in
   * it, so two units' commits to one partition land as they were prepared.
   */
  readonly sequence: number;
  /** When the entry was first prepared, epoch milliseconds. */
  readonly createdAt: number;
}

/** The fences a copy of `commits.db` took, as {@link decideFenceChain} keeps them. */
export interface FenceChain {
  /** The last fence the copy took. */
  readonly lastFence: number;
  /** The first fence of the copy's current unbroken run of fences. */
  readonly chainStart: number;
  /**
   * The fence of the last completed recovery on this copy; 0 before any.
   * Never above `lastFence`.
   */
  readonly floor: number;
}

/**
 * The chain once this copy took `fence`. Equal to the last fence (another
 * hold in the process seen again) or one above it (no other writer took the
 * lease in between) continues it; anything else restarts it at `fence`.
 * A fence lower than the last means the lease's records were recreated, and
 * restarts the chain and the floor.
 */
export function decideFenceChain(
  previous: FenceChain | undefined,
  fence: number,
): FenceChain {
  if (!Number.isSafeInteger(fence) || fence < 1) {
    throw new Error(`A writer fence must be an integer from 1: ${fence}`);
  }
  if (previous === undefined) {
    return { lastFence: fence, chainStart: fence, floor: 0 };
  }
  if (fence === previous.lastFence || fence === previous.lastFence + 1) {
    return { ...previous, lastFence: fence };
  }
  return {
    lastFence: fence,
    chainStart: fence,
    floor: fence < previous.lastFence ? 0 : previous.floor,
  };
}

/** Why recovery dropped an entry instead of landing it. */
export type OutboxDropReason =
  /** Another copy took the lease after it was prepared. */
  | "stale-fence"
  /** Its writer lost the lease, and prepared it after a later recovery. */
  | "overtaken"
  /** Older than the retry bound. */
  | "expired"
  /** A run entry of a unit whose other entry was dropped (decision 7). */
  | "unit-dropped"
  /** The partition moved on since the entry was built. */
  | "head-moved"
  /** The store refused it. */
  | "refused"
  /** A chunk it names is missing, and nothing can store it again. */
  | "missing-chunk"
  /** It could not be read or rebuilt. */
  | "unreadable";

/** One entry recovery dropped, and why. */
export interface OutboxDrop {
  readonly entry: OutboxEntry;
  readonly reason: OutboxDropReason;
  /** The error behind a `refused`, `missing-chunk` or `unreadable` drop. */
  readonly detail?: string;
}

/** What {@link planOutboxRecovery} judges with. */
export interface OutboxRecoveryJudgement {
  /** The copy's chain, recorded with the recovering writer's fence. */
  readonly chain: FenceChain;
  /** Now, epoch milliseconds. */
  readonly now: number;
  /**
   * Whether the entry's writer may still be running: this process, or one
   * on this host that is not gone. Its entries are left alone.
   */
  readonly writerAlive: (writer: CommitWriter) => boolean;
}

/** The outcome of {@link planOutboxRecovery}. */
export interface OutboxRecoveryPlan {
  /** Entries to land, in order. Run entries of a unit come last. */
  readonly sends: readonly OutboxEntry[];
  readonly drops: readonly OutboxDrop[];
  /** Entries of writers that may still be running, left as they are. */
  readonly skipped: readonly OutboxEntry[];
}

/**
 * Decides which entries a recovery lands, drops or leaves. Entries are
 * taken in preparation order; a unit's run entries go after its others,
 * and are dropped when one of them is (decision 7: a run record never names
 * data that did not land). The live checks, the head and the store's own
 * refusal, are the executor's; {@link dropsAfterRefusal} applies decision 7
 * to what they drop.
 */
export function planOutboxRecovery(
  entries: readonly OutboxEntry[],
  judgement: OutboxRecoveryJudgement,
): OutboxRecoveryPlan {
  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
  const skipped: OutboxEntry[] = [];
  const drops: OutboxDrop[] = [];
  const kept: OutboxEntry[] = [];
  for (const entry of ordered) {
    const reason = dropReason(entry, judgement);
    if (reason === "skip") skipped.push(entry);
    else if (reason !== undefined) drops.push({ entry, reason });
    else kept.push(entry);
  }
  const droppedUnits = new Set(
    drops.filter((drop) => !isRunEntry(drop.entry)).map((drop) =>
      drop.entry.unitId
    ),
  );
  const sends: OutboxEntry[] = [];
  const runs: OutboxEntry[] = [];
  for (const entry of kept) {
    if (!isRunEntry(entry)) sends.push(entry);
    else if (droppedUnits.has(entry.unitId)) {
      drops.push({ entry, reason: "unit-dropped" });
    } else runs.push(entry);
  }
  return { sends: [...sends, ...runs], drops, skipped };
}

/**
 * The run entries among `remaining` that a drop of `dropped` takes with it:
 * those of the same unit, when `dropped` is not itself a run entry.
 */
export function dropsAfterRefusal(
  dropped: OutboxEntry,
  remaining: readonly OutboxEntry[],
): OutboxEntry[] {
  if (isRunEntry(dropped)) return [];
  return remaining.filter((entry) =>
    isRunEntry(entry) && entry.unitId === dropped.unitId
  );
}

/** Whether an entry commits a workflow run's partition. */
export function isRunEntry(entry: OutboxPreparation): boolean {
  return entry.commit.partition.kind === "run";
}

function dropReason(
  entry: OutboxEntry,
  { chain, now, writerAlive }: OutboxRecoveryJudgement,
): OutboxDropReason | "skip" | undefined {
  const fence = entry.commit.fence;
  if (fence === undefined || fence < chain.chainStart) return "stale-fence";
  if (fence < chain.floor) return "overtaken";
  if (writerAlive(entry.commit.writer)) return "skip";
  if (now - entry.createdAt > OUTBOX_RETRY_BOUND_MS) return "expired";
  return undefined;
}

/** A sweep's state, as a writer reads it before and after preparing. */
export interface SweepState {
  /** Moves when a sweep starts and when it ends. */
  readonly epoch: number;
  /** Whether a sweep is in progress and its heartbeat is fresh. */
  readonly active: boolean;
}

/**
 * Whether a writer must check its chunks before appending: a sweep was in
 * progress at either read, or one started or ended between them, so a chunk
 * it found present may have been deleted. Otherwise any sweep that deletes
 * one of its chunks starts after the entry was prepared, and its re-check
 * sees the entry and puts the chunk back.
 */
export function sweepMayOverlap(
  before: SweepState,
  after: SweepState,
): boolean {
  return before.active || after.active || before.epoch !== after.epoch;
}

/** What {@link CommitOutbox.entries} lists. */
export interface OutboxListing {
  readonly entries: readonly OutboxEntry[];
  /** Entries whose commit can no longer be read; recovery drops them. */
  readonly unreadable: readonly {
    readonly key: OutboxKey;
    readonly detail: string;
  }[];
}

/**
 * Where a copy of `commits.db` keeps its prepared commits: the port of the
 * commit outbox. Durable on this machine, never replicated.
 */
export interface CommitOutbox {
  /**
   * Records `preparation`, replacing an entry with the same key and keeping
   * its sequence and creation time.
   */
  prepare(preparation: OutboxPreparation): Promise<void>;
  /** Removes the entries with these keys, landed or given up. */
  remove(keys: readonly OutboxKey[]): Promise<void>;
  /** Every entry, in preparation order, and those that cannot be read. */
  entries(): Promise<OutboxListing>;
  /** Whether any entry is held. */
  hasEntries(): Promise<boolean>;
  /** Records that this copy took `fence`, by {@link decideFenceChain}. */
  recordFence(fence: number): Promise<FenceChain>;
  /** The copy's chain, or undefined before any fence was recorded. */
  chain(): Promise<FenceChain | undefined>;
  /** Moves the floor to `fence` once a recovery under it completed. */
  raiseFloor(fence: number): Promise<void>;
  /** The subset of `hashes` an entry of `namespace` names as a chunk. */
  referencedChunks(
    namespace: string,
    hashes: readonly string[],
  ): Promise<Set<string>>;
  /** The sweep state, judged against `now` (epoch milliseconds). */
  sweepState(now: number): Promise<SweepState>;
  /** Marks a sweep by `instance` started at `now`, and moves the epoch. */
  beginSweep(instance: string, now: number): Promise<void>;
  /** Renews the sweep's heartbeat. */
  heartbeatSweep(instance: string, now: number): Promise<void>;
  /** Marks the sweep ended, and moves the epoch. */
  endSweep(instance: string): Promise<void>;
  close(): Promise<void>;
}
