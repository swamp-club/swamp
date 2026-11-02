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
 * an entry lands only when its txnId is already stored or the partition head is
 * still its base, under the recovering writer's fence; entries from before the
 * fence chain's start or below the floor are dropped
 */

import type { Commit, CommitWriter } from "./commit.ts";
import type { ProcessIdentity } from "./process_liveness.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * days, so a machine that was off over a long weekend still lands what it
 * prepared
 */
export const OUTBOX_RETRY_BOUND_DAYS = 7;

export const OUTBOX_RETRY_BOUND_MS = OUTBOX_RETRY_BOUND_DAYS * DAY_MS;

/**
 * longer than the retry bound by a day of slack, more than any clock skew
 * between writer and compactor, so a retry inside the bound never finds its
 * txnId pruned
 */
export const COMPACTED_TXN_RETENTION_MS = OUTBOX_RETRY_BOUND_MS + DAY_MS;

export const OUTBOX_SWEEP_STALE_MS = 15 * 60 * 1000;

/**
 * txnId is undefined at seq 0 and when the store keeps only the seq (the head
 * commit was compacted and its txnId pruned)
 */
export interface HeadIdentity {
  readonly seq: number;
  readonly txnId: string | undefined;
}

/**
 * a txnId either side lacks is not compared: the store then knows only the seq,
 * which a restore can never take below the compaction point
 */
export function sameHead(base: HeadIdentity, current: HeadIdentity): boolean {
  if (base.seq !== current.seq) return false;
  if (base.txnId === undefined || current.txnId === undefined) return true;
  return base.txnId === current.txnId;
}

export interface OutboxKey {
  readonly namespace: string;
  readonly partition: string;
  readonly txnId: string;
}

export function outboxKeyOf(commit: Commit): OutboxKey {
  return {
    namespace: commit.namespace,
    partition: commit.partition.toString(),
    txnId: commit.txnId,
  };
}

export interface OutboxPreparation {
  /**
   * The commit as it is about to be appended: its ops, writer and fence. A
   * recovery rebuilds it at the head it finds, under its own fence.
   */
  readonly commit: Commit;
  readonly unitId: string;
  readonly base: HeadIdentity;
  /**
   * a recovery resends the commit naming that lease, so serve refuses it once
   * the lease has changed hands
   */
  readonly lease?: OutboxLease;
  /**
   * the entry is written marked offline, so a process that dies before the
   * queue's mark leaves it offline, never pending
   */
  readonly queuedOffline?: boolean;
}

/**
 * offline entries are never dropped, being possibly the only record of a
 * change; rejected ones could not land and are kept and reported; quarantined
 * ones lack a needed grant and wait for an admin
 */
export type OutboxEntryState = "offline" | "rejected" | "quarantined";

export interface OutboxLease {
  readonly leaseId: string;
  readonly fence: number;
}

export interface OutboxEntry extends OutboxPreparation {
  /**
   * recovery lands entries in this order, so two units' commits to one
   * partition land as they were prepared
   */
  readonly sequence: number;
  readonly createdAt: number;
  /** liveness is judged by it; undefined in an entry from an older swamp */
  readonly writerProcess?: ProcessIdentity;
  /**
   * The fence of the recovery that left this entry for its live writer,
   * since it was last prepared: the floor does not drop it.
   */
  readonly leftAtFence?: number;
  /**
   * the unit reported the failure, so recovery drops the entry whatever its
   * writer's state, a left entry included
   */
  readonly abandonedAt?: number;
  readonly state?: OutboxEntryState;
  readonly stateReason?: string;
  /**
   * serve keeps a landed commit's txnId for COMPACTED_TXN_RETENTION_MS; past
   * that the flush cannot tell whether it landed and never sends it again
   */
  readonly sentMaybeAt?: number;
}

export interface FenceChain {
  readonly lastFence: number;
  readonly chainStart: number;
  readonly floor: number;
}

export interface FenceChainContext {
  /**
   * a note one above the last fence is this copy's own fence whose record was
   * lost (writer killed or failed between note and record): the chain counts it
   * as taken
   */
  readonly pendingFence?: number;
  /**
   * only a replicated datastore can have a gap in the fences that is another
   * copy's; taken as true when not given
   */
  readonly replicated?: boolean;
}

/**
 * equal or one above the last fence continues the chain; a higher one continues
 * it only in shared mode and restarts it while replicating; a lower one
 * restarts chain and floor
 */
export function decideFenceChain(
  previous: FenceChain | undefined,
  fence: number,
  context: FenceChainContext = {},
): FenceChain {
  if (!Number.isSafeInteger(fence) || fence < 1) {
    throw new Error(`A writer fence must be an integer from 1: ${fence}`);
  }
  // A chain at fence 0 only holds a note: no fence was recorded yet.
  if (previous === undefined || previous.lastFence === 0) {
    return { lastFence: fence, chainStart: fence, floor: 0 };
  }
  if (fence < previous.lastFence) {
    return { lastFence: fence, chainStart: fence, floor: 0 };
  }
  const last = context.pendingFence === previous.lastFence + 1
    ? context.pendingFence
    : previous.lastFence;
  if (
    fence === last || fence === last + 1 || context.replicated === false
  ) {
    return { ...previous, lastFence: fence };
  }
  return { lastFence: fence, chainStart: fence, floor: previous.floor };
}

export type OutboxDropReason =
  | "abandoned"
  | "stale-fence"
  | "overtaken"
  | "expired"
  | "unit-dropped"
  | "head-moved"
  | "refused"
  | "lease-superseded"
  | "missing-chunk"
  | "unreadable";

export interface OutboxDrop {
  readonly entry: OutboxEntry;
  readonly reason: OutboxDropReason;
  readonly detail?: string;
  /**
   * an expired entry older than COMPACTED_TXN_RETENTION_MS, whose txnId
   * compaction may have pruned, so whether it landed cannot be seen
   */
  readonly uncertain?: boolean;
}

export interface OutboxRecoveryJudgement {
  readonly chain: FenceChain;
  readonly now: number;
  /**
   * Whether the entry's writer may still be running: this process, or one
   * judged alive by the identity it prepared the entry under. Its entries
   * are left alone.
   */
  readonly writerAlive: (
    writer: CommitWriter,
    process: ProcessIdentity | undefined,
  ) => boolean;
  /**
   * such an entry settles whatever drop reason it would otherwise meet; none
   * landed when not given
   */
  readonly landed?: (entry: OutboxEntry) => boolean;
}

export interface OutboxRecoveryPlan {
  readonly settles: readonly OutboxEntry[];
  readonly sends: readonly OutboxEntry[];
  readonly drops: readonly OutboxDrop[];
  readonly skipped: readonly OutboxEntry[];
  /**
   * queued offline and not landed, in order: the flush rebases and sends them;
   * never dropped
   */
  readonly offline: readonly OutboxEntry[];
  readonly held: readonly OutboxEntry[];
}

/**
 * abandoned entries drop first; a landed commit settles before other drop
 * reasons; a unit's run entries go last and drop when one drops, so a run
 * record never names data that did not land
 */
export function planOutboxRecovery(
  entries: readonly OutboxEntry[],
  judgement: OutboxRecoveryJudgement,
): OutboxRecoveryPlan {
  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
  const skipped: OutboxEntry[] = [];
  const settles: OutboxEntry[] = [];
  const drops: OutboxDrop[] = [];
  const kept: OutboxEntry[] = [];
  const offline: OutboxEntry[] = [];
  const held: OutboxEntry[] = [];
  for (const entry of ordered) {
    // an entry queued offline or kept after a rejection may be the only record
    // of what a run changed, so no drop rule takes it; one its unit gave up was
    // reported failed, so it drops as abandoned
    if (entry.state !== undefined && entry.abandonedAt === undefined) {
      if (judgement.landed?.(entry) === true) settles.push(entry);
      else if (entry.state === "offline") offline.push(entry);
      else held.push(entry);
      continue;
    }
    const reason = dropReason(entry, judgement);
    if (reason === "skip") skipped.push(entry);
    else if (reason === "settle") settles.push(entry);
    else if (reason === "expired" && mayBePruned(entry, judgement.now)) {
      drops.push({ entry, reason, uncertain: true });
    } else if (reason !== undefined) drops.push({ entry, reason });
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
  return {
    settles,
    sends: [...sends, ...runs],
    drops,
    skipped,
    offline,
    held,
  };
}

export function dropsAfterRefusal(
  dropped: OutboxEntry,
  remaining: readonly OutboxEntry[],
): OutboxEntry[] {
  if (isRunEntry(dropped)) return [];
  return remaining.filter((entry) =>
    isRunEntry(entry) && entry.unitId === dropped.unitId
  );
}

export function isRunEntry(entry: OutboxPreparation): boolean {
  return entry.commit.partition.kind === "run";
}

function dropReason(
  entry: OutboxEntry,
  { chain, now, writerAlive, landed }: OutboxRecoveryJudgement,
): OutboxDropReason | "skip" | "settle" | undefined {
  if (entry.abandonedAt !== undefined) return "abandoned";
  // Landed already: settling it can lose nothing, whoever wrote it.
  if (landed?.(entry) === true) return "settle";
  const fence = entry.commit.fence;
  if (fence === undefined || fence < chain.chainStart) return "stale-fence";
  if (fence < chain.floor && entry.leftAtFence === undefined) {
    return "overtaken";
  }
  if (writerAlive(entry.commit.writer, entry.writerProcess)) return "skip";
  if (now - entry.createdAt > OUTBOX_RETRY_BOUND_MS) return "expired";
  return undefined;
}

function mayBePruned(entry: OutboxEntry, now: number): boolean {
  return now - entry.createdAt > COMPACTED_TXN_RETENTION_MS;
}

export interface SweepState {
  readonly epoch: number;
  readonly active: boolean;
}

/**
 * a sweep active at either read, or started or ended between them, may have
 * deleted a chunk found present; otherwise a deleting sweep starts after the
 * entry was prepared and its re-check sees the entry
 */
export function sweepMayOverlap(
  before: SweepState,
  after: SweepState,
): boolean {
  return before.active || after.active || before.epoch !== after.epoch;
}

export interface OutboxListing {
  readonly entries: readonly OutboxEntry[];
  /**
   * recovery drops a pending one; one with a state is kept and reported, since
   * it may be the only record of what a run changed
   */
  readonly unreadable: readonly {
    readonly key: OutboxKey;
    readonly detail: string;
    readonly state?: string;
  }[];
}

/** durable on this machine, never replicated */
export interface CommitOutbox {
  prepare(preparation: OutboxPreparation): Promise<void>;
  /**
   * a settle may be lost to a power cut: the entry comes back and the next
   * recovery settles it again on finding its txnId landed
   */
  settle(keys: readonly OutboxKey[]): Promise<void>;
  /**
   * the outcome was reported, so a discard survives a power cut; an entry back
   * from one could be landed by the next recovery
   */
  discard(keys: readonly OutboxKey[]): Promise<void>;
  /**
   * marked durably before discarding: recovery drops a marked entry, so a
   * failed discard cannot let a reported failure land; a later prepare clears
   * the mark
   */
  abandon(keys: readonly OutboxKey[]): Promise<void>;
  entries(): Promise<OutboxListing>;
  hasEntries(): Promise<boolean>;
  /**
   * offline keeps an entry a failing unit would discard; rejected and
   * quarantined keep one a flush could not land; a later prepare of the same
   * key keeps the mark
   */
  markState(
    keys: readonly OutboxKey[],
    state: OutboxEntryState,
    reason?: string,
  ): Promise<void>;
  /**
   * an earlier record is kept: serve's txnId retention runs from the first time
   * the commit may have landed
   */
  markSentMaybe(key: OutboxKey, at: number): Promise<void>;
  /**
   * a command allocates above it, so work queued offline never reuses a version
   * another queued commit holds
   */
  queuedDataHighWater(
    namespace: string,
    partition: string,
    name: string,
  ): Promise<number>;
  /**
   * the note only ever rises; one left one above the chain's last fence by a
   * writer that died before its record joins the chain first
   */
  notePendingFence(fence: number): Promise<void>;
  recordFence(
    fence: number,
    options?: { readonly replicated?: boolean },
  ): Promise<FenceChain>;
  chain(): Promise<FenceChain | undefined>;
  raiseFloor(fence: number): Promise<void>;
  /**
   * Marks entries a recovery at `fence` left for their live writer, so a
   * later floor does not drop them; a later prepare clears the mark.
   */
  markLeft(keys: readonly OutboxKey[], fence: number): Promise<void>;
  referencedChunks(
    namespace: string,
    hashes: readonly string[],
  ): Promise<Set<string>>;
  sweepState(now: number): Promise<SweepState>;
  beginSweep(instance: string, now: number): Promise<void>;
  heartbeatSweep(instance: string, now: number): Promise<void>;
  endSweep(instance: string): Promise<void>;
  close(): Promise<void>;
}
