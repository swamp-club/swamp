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
 * entries go in outbox order, each rebased on the caught-up partition and built
 * under its original txnId, so one a cut-off flush landed settles next time; an
 * entry leaves the outbox only once landed
 */

import {
  RUN_INITIATOR_MISMATCH_CODE,
  RUN_INITIATOR_MISMATCH_REASON,
} from "../../domain/datastore_v3/commit_authorization.ts";
import { Commit, type CommitWriter } from "../../domain/datastore_v3/commit.ts";
import {
  COMPACTED_TXN_RETENTION_MS,
  type OutboxEntry,
  type OutboxEntryState,
  type OutboxKey,
  outboxKeyOf,
} from "../../domain/datastore_v3/commit_outbox.ts";
import { CommitsCompactedError } from "../../domain/datastore_v3/commit_store.ts";
import {
  behaviorOf,
  type RejectedWrite,
  rejectedWritesOf,
} from "../../domain/datastore_v3/rejected_write.ts";
import type { DataMetadata } from "../../domain/data/data_metadata.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  restatedVersionOf,
  type VersionObservation,
} from "../../domain/datastore_v3/latest_choice.ts";
import {
  EMPTY_REBASE_CARRY,
  type LatestOutcome,
  mergeRebaseCarry,
  type OfflineRebaseCarry,
  type OfflineRebaseLookups,
  rebaseOfflineCommits,
  type RenumberedVersion,
  type VersionContent,
} from "../../domain/datastore_v3/offline_rebase.ts";
import { type Op, putOp } from "../../domain/datastore_v3/op.ts";
import {
  CommitRejectedError,
  type Partition,
} from "../../domain/datastore_v3/partition.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import type { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { ChunkIngestError } from "./chunk_ingest.ts";
import {
  ChunkNotCachedError,
  ServeCommitMayLandError,
  ServeCommitRefusedError,
  ServeNeverReadError,
  ServeUnreachableError,
  ServeUpstreamDivergedError,
  ServeUpstreamError,
  ServeUpstreamUpgradeRequiredError,
} from "./serve_upstream_errors.ts";
import { emitServeOfflineNotice } from "./serve_offline.ts";
import { CommitNotTriedError } from "./commit_log_unit_of_work.ts";
import { withSpan } from "../tracing/tracer.ts";

const logger = getSwampLogger(["datastore", "v3", "offline"]);

const FLUSH_SEQ_GAP_ATTEMPTS = 8;

/** entries of one partition and lease built together and sent as one request */
export const FLUSH_BLOCK_ENTRIES = 16;

export interface OfflineFlushPort {
  catchUpPartition(namespace: string, partition: PartitionKey): Promise<void>;
  partitionState(
    namespace: string,
    partition: PartitionKey,
  ): Promise<Partition>;
  partitionCommits(
    namespace: string,
    partition: PartitionKey,
  ): Promise<readonly Commit[]>;
  head(namespace: string, partition: PartitionKey): Promise<number>;
  send(commit: Commit, leaseId: string | undefined): Promise<unknown>;
  /**
   * the commits in order as one request, each settled as send would settle it
   * alone; undefined when serve takes no batches
   */
  sendBatch?(
    sends: readonly {
      readonly commit: Commit;
      readonly leaseId: string | undefined;
    }[],
  ): Promise<readonly PromiseSettledResult<unknown>[] | undefined>;
  encodeMetadata(metadata: DataMetadata): Uint8Array;
  storeChunks(namespace: string, bytes: Uint8Array): Promise<BlobRef>;
  mark(
    keys: readonly OutboxKey[],
    state: OutboxEntryState,
    reason?: string,
    code?: string,
  ): Promise<void>;
  settle(keys: readonly OutboxKey[]): Promise<void>;
  /**
   * Records that an offline entry landed, before its settle: a later flush
   * judges the versions it wrote as this checkout's own, and its later
   * entries follow what it renumbered and rewrote (`carry`).
   */
  recordOwnLanded?(
    key: OutboxKey,
    at: number,
    carry?: OfflineRebaseCarry,
  ): Promise<void>;
  landedCarry?(
    namespace: string,
    partition: PartitionKey,
  ): Promise<OfflineRebaseCarry>;
  ownLanded?(
    namespace: string,
    partition: PartitionKey,
  ): Promise<ReadonlySet<string>>;
  markSentMaybe?(key: OutboxKey, at: number): Promise<void>;
  compactedThrough?(
    namespace: string,
    partition: PartitionKey,
  ): Promise<number>;
  compactedVersion?(
    namespace: string,
    partition: PartitionKey,
    name: string,
    version: number,
  ): Promise<
    | { readonly metadata: DataMetadata; readonly raw?: Uint8Array }
    | undefined
  >;
  /**
   * an entry serve refused for a missing grant, now marked quarantined and
   * deposited with serve for an admin to accept; a failed deposit is logged and
   * the entry stays either way
   */
  quarantined?(entry: OutboxEntry, reason: string): Promise<void>;
  /**
   * what serve did with a quarantined entry's deposit; undefined when serve
   * holds none or cannot be asked. A discarded one is settled here as declined
   */
  quarantineState?(
    entry: OutboxEntry,
  ): Promise<"held" | "accepted" | "discarded" | undefined>;
}

export interface OfflineFlushReport {
  readonly landed: number;
  readonly waiting: number;
  readonly rejected: number;
  readonly quarantined: number;
  readonly rejectedWrites: readonly RejectedWrite[];
  readonly renumbered: readonly FlushedVersion[];
  readonly latest: readonly FlushedLatest[];
  readonly latestAtEnd: readonly FlushedLatest[];
}

export type FlushedVersion = RenumberedVersion & { readonly behavior: string };

export type FlushedLatest = LatestOutcome & { readonly behavior: string };

/**
 * a later entry's outcome supersedes an earlier one's for the same behavior and
 * name; names of different behaviors never mix, though spelled alike
 */
export function latestAtEndOf(
  latest: readonly FlushedLatest[],
): FlushedLatest[] {
  const atEnd = new Map<string, FlushedLatest>();
  for (const choice of latest) {
    atEnd.set(JSON.stringify([choice.behavior, choice.name]), choice);
  }
  return [...atEnd.values()];
}

type EntryOutcome =
  | {
    readonly kind: "landed";
    readonly renumbered: readonly RenumberedVersion[];
    readonly latest: readonly LatestOutcome[];
    readonly carry: OfflineRebaseCarry;
  }
  | { readonly kind: "waiting" }
  | { readonly kind: "stop"; readonly sentMaybe?: boolean }
  | {
    readonly kind: "rejected";
    readonly reason: string;
    readonly code?: string;
  }
  | { readonly kind: "quarantined"; readonly reason: string };

export async function flushOfflineEntries(
  port: OfflineFlushPort,
  entries: readonly OutboxEntry[],
  options: {
    readonly writer: CommitWriter;
    readonly fence: number;
    readonly clock?: () => Date;
    readonly signal?: AbortSignal;
  },
): Promise<OfflineFlushReport> {
  const clock = options.clock ?? (() => new Date());
  let landed = 0;
  let waiting = 0;
  let rejected = 0;
  let quarantined = 0;
  const rejectedWrites: RejectedWrite[] = [];
  const renumbered: FlushedVersion[] = [];
  const latest: FlushedLatest[] = [];
  // A partition whose entry waits keeps its later entries waiting too:
  // they were queued after it.
  const held = new Set<string>();
  const flushed = new Set<string>();
  const carries = new Map<string, OfflineRebaseCarry>();
  const carryOf = async (entry: OutboxEntry): Promise<OfflineRebaseCarry> => {
    const id = entry.commit.partition.toString();
    let carry = carries.get(id);
    if (carry === undefined) {
      carry = await port.landedCarry?.(
        entry.commit.namespace,
        entry.commit.partition,
      ) ?? EMPTY_REBASE_CARRY;
      carries.set(id, carry);
    }
    return carry;
  };
  let stopped = false;
  let batching = port.sendBatch !== undefined;
  // set when a block leaves its next entry to a send of its own
  let aloneNext = false;
  const record = async (
    entry: OutboxEntry,
    outcome: EntryOutcome,
  ): Promise<void> => {
    const partition = entry.commit.partition.toString();
    const key = outboxKeyOf(entry.commit);
    switch (outcome.kind) {
      case "landed":
        landed++;
        flushed.add(entry.commit.txnId);
        for (const version of outcome.renumbered) {
          renumbered.push({
            ...version,
            behavior: behaviorOf(entry.commit.partition),
          });
        }
        for (const choice of outcome.latest) {
          latest.push({
            ...choice,
            behavior: behaviorOf(entry.commit.partition),
          });
        }
        carries.set(
          partition,
          mergeRebaseCarry(await carryOf(entry), outcome.carry),
        );
        await port.recordOwnLanded?.(key, clock().getTime(), outcome.carry);
        await port.settle([key]);
        break;
      case "waiting":
        waiting++;
        held.add(partition);
        break;
      case "stop":
        waiting++;
        stopped = true;
        if (outcome.sentMaybe === true && port.markSentMaybe !== undefined) {
          await port.markSentMaybe(key, clock().getTime());
        }
        break;
      case "rejected": {
        rejected++;
        held.add(partition);
        await port.mark([key], "rejected", outcome.reason, outcome.code);
        const writes = rejectedWritesOf(entry.commit, outcome);
        for (const write of writes) {
          rejectedWrites.push(write);
          warnRejected(write);
        }
        break;
      }
      case "quarantined":
        quarantined++;
        held.add(partition);
        await port.mark([key], "quarantined", outcome.reason);
        logger
          .warn`Serve refused a change this checkout saved offline to ${partition} because you lack a grant it needs; it is quarantined, kept in this checkout's outbox for an admin to accept: ${outcome.reason}`;
        if (port.quarantined !== undefined) {
          try {
            await port.quarantined(entry, outcome.reason);
          } catch (error) {
            logger
              .warn`Could not hand the quarantined change to serve; it stays in this checkout's outbox: ${error}`;
          }
        }
        break;
    }
  };
  for (let index = 0; index < entries.length;) {
    options.signal?.throwIfAborted();
    const entry = entries[index];
    const partition = entry.commit.partition.toString();
    if (stopped || held.has(partition)) {
      waiting++;
      index++;
      continue;
    }
    const block = batching && !aloneNext ? blockFrom(entries, index) : [];
    aloneNext = false;
    if (block.length > 1) {
      const sent = await flushBlock(
        port,
        block,
        entries,
        options,
        clock,
        flushed,
        await carryOf(entry),
      );
      if (sent.unavailable) batching = false;
      for (const [offset, outcome] of sent.outcomes.entries()) {
        await record(block[offset], outcome);
      }
      index += sent.outcomes.length;
      aloneNext = sent.single;
      continue;
    }
    const single = entries[index];
    let outcome: EntryOutcome;
    try {
      outcome = await flushEntry(
        port,
        single,
        options,
        clock,
        flushed,
        await carryOf(single),
        reservedBy(entries, single, flushed),
      );
    } catch (error) {
      if (stopsTheFlush(error)) throw error;
      if (isEntryOwnError(error)) {
        outcome = { kind: "rejected", reason: messageOf(error) };
      } else {
        // A local failure that may pass (a full disk, a refused
        // permission): the entry stays queued and is tried again.
        logger
          .warn`Could not send a change this checkout saved offline to ${single.commit.partition.toString()}; it stays queued and a later command tries again: ${error}`;
        outcome = { kind: "stop" };
      }
    }
    await record(single, outcome);
    index++;
  }
  const report = {
    landed,
    waiting,
    rejected,
    quarantined,
    rejectedWrites,
    renumbered,
    latest,
    latestAtEnd: latestAtEndOf(latest),
  };
  reportFlush(report);
  emitServeOfflineNotice({ notice: "datastore_offline_flush", ...report });
  return report;
}

/** an entry sent before without an answer goes alone, for its age check */
function blockFrom(
  entries: readonly OutboxEntry[],
  start: number,
): OutboxEntry[] {
  const first = entries[start];
  const block: OutboxEntry[] = [];
  for (
    let index = start;
    index < entries.length && block.length < FLUSH_BLOCK_ENTRIES;
    index++
  ) {
    const entry = entries[index];
    if (
      entry.sentMaybeAt !== undefined ||
      !entry.commit.partition.equals(first.commit.partition) ||
      entry.lease?.leaseId !== first.lease?.leaseId
    ) {
      break;
    }
    block.push(entry);
  }
  return block;
}

interface BlockOutcome {
  /** may be shorter than the block */
  readonly outcomes: readonly EntryOutcome[];
  /** the entry after them goes alone, with every retry a single send has */
  readonly single: boolean;
  /** serve takes no batches: the rest of the flush sends alone */
  readonly unavailable?: boolean;
}

/** each entry is built on the partition read once, with the earlier ones applied */
function flushBlock(
  port: OfflineFlushPort,
  block: readonly OutboxEntry[],
  entries: readonly OutboxEntry[],
  options: { readonly writer: CommitWriter; readonly fence: number },
  clock: () => Date,
  flushed: ReadonlySet<string>,
  carry: OfflineRebaseCarry,
): Promise<BlockOutcome> {
  return withSpan(
    "swamp.datastore.v3.offline_flush.block",
    { "swamp.datastore.v3.commits": block.length },
    async (span) => {
      const outcome = await flushBlockIn(
        port,
        block,
        entries,
        options,
        clock,
        flushed,
        carry,
      );
      span.setAttribute(
        "swamp.datastore.v3.landed",
        outcome.outcomes.filter((one) => one.kind === "landed").length,
      );
      return outcome;
    },
  );
}

async function flushBlockIn(
  port: OfflineFlushPort,
  block: readonly OutboxEntry[],
  entries: readonly OutboxEntry[],
  options: { readonly writer: CommitWriter; readonly fence: number },
  clock: () => Date,
  flushed: ReadonlySet<string>,
  carry: OfflineRebaseCarry,
): Promise<BlockOutcome> {
  const first = block[0].commit;
  const namespace = first.namespace;
  let partition: Partition;
  let head: number;
  let history: Commit[];
  try {
    await withSpan(
      "swamp.datastore.v3.offline_flush.catch_up",
      {},
      () => port.catchUpPartition(namespace, first.partition),
    );
    partition = await port.partitionState(namespace, first.partition);
    head = await port.head(namespace, first.partition);
    history = [...await port.partitionCommits(namespace, first.partition)];
  } catch (error) {
    if (error instanceof ServeUnreachableError) {
      return { outcomes: [{ kind: "stop" }], single: false };
    }
    // the first entry alone meets the same failure and settles it as ever
    return { outcomes: [], single: true };
  }
  const built: {
    readonly entry: OutboxEntry;
    readonly commit: Commit;
    readonly landed: Extract<EntryOutcome, { kind: "landed" }>;
  }[] = [];
  const builtFlushed = new Set(flushed);
  let builtCarry = carry;
  for (const entry of block) {
    try {
      const lookups = await withSpan(
        "swamp.datastore.v3.offline_flush.lookups",
        {},
        () =>
          lookupsOf(port, namespace, entry.commit, partition, {
            baseSeq: entry.base.seq,
            flushed: builtFlushed,
            history,
          }),
      );
      const [rebased] = await asEntryOwn(() =>
        rebaseOfflineCommits([entry.commit], partition, lookups, {
          encodeMetadata: port.encodeMetadata,
          restate: true,
          carry: builtCarry,
          reserved: reservedBy(entries, entry, builtFlushed),
          floor: () => 0,
        })
      );
      // a rejected rebuild is the entry's own to settle, alone
      if (rebased.kind === "rejected") break;
      const ops = rebased.kind === "unchanged"
        ? rebased.commit.ops
        : await opsOf(port, namespace, rebased.changes);
      const landed: Extract<EntryOutcome, { kind: "landed" }> =
        rebased.kind === "unchanged"
          ? {
            kind: "landed",
            renumbered: [],
            latest: [],
            carry: EMPTY_REBASE_CARRY,
          }
          : {
            kind: "landed",
            renumbered: rebased.renumbered,
            latest: rebased.latest,
            carry: rebased.carry,
          };
      const commit = await asEntryOwn(() =>
        Promise.resolve(
          buildCommit(entry.commit, ops, head + built.length, options, clock),
        )
      );
      // as the copy would hold it once the entry before it landed
      partition.appendObserved(commit);
      history.push(commit);
      builtFlushed.add(entry.commit.txnId);
      builtCarry = mergeRebaseCarry(builtCarry, landed.carry);
      built.push({ entry, commit, landed });
    } catch {
      // whatever stopped this build happens again alone, where it is settled
      break;
    }
  }
  if (built.length === 0) return { outcomes: [], single: true };
  const results = await port.sendBatch!(
    built.map(({ entry, commit }) => ({
      commit,
      leaseId: entry.lease?.leaseId,
    })),
  );
  if (results === undefined) {
    return { outcomes: [], single: true, unavailable: true };
  }
  const outcomes: EntryOutcome[] = [];
  let stopping = false;
  for (const [index, result] of results.entries()) {
    // one that landed is recorded so even after one before it was cut off
    if (result.status === "fulfilled") {
      outcomes.push(built[index].landed);
      continue;
    }
    const error = result.reason;
    // a request cut off may have landed every entry it carried: each is
    // marked so, and a later flush sends it alone
    if (error instanceof ServeUnreachableError) {
      stopping = true;
      outcomes.push({ kind: "stop", sentMaybe: error.sent === "maybe" });
      continue;
    }
    if (error instanceof ServeCommitMayLandError) {
      stopping = true;
      outcomes.push({ kind: "stop", sentMaybe: true });
      continue;
    }
    if (stopping) break;
    // a refused entry is sent again alone; the ones after it were not tried
    return { outcomes, single: !(error instanceof CommitNotTriedError) };
  }
  if (stopping) return { outcomes, single: false };
  return { outcomes, single: built.length < block.length };
}

function flushEntry(
  port: OfflineFlushPort,
  entry: OutboxEntry,
  options: { readonly writer: CommitWriter; readonly fence: number },
  clock: () => Date,
  flushed: ReadonlySet<string>,
  carry: OfflineRebaseCarry,
  reserved: (name: string) => ReadonlySet<number>,
): Promise<EntryOutcome> {
  return withSpan(
    "swamp.datastore.v3.offline_flush.entry",
    {},
    async (span) => {
      const outcome = await flushEntryIn(
        port,
        entry,
        options,
        clock,
        flushed,
        carry,
        reserved,
      );
      span.setAttribute("swamp.datastore.v3.outcome", outcome.kind);
      return outcome;
    },
  );
}

async function flushEntryIn(
  port: OfflineFlushPort,
  entry: OutboxEntry,
  options: { readonly writer: CommitWriter; readonly fence: number },
  clock: () => Date,
  flushed: ReadonlySet<string>,
  carry: OfflineRebaseCarry,
  reserved: (name: string) => ReadonlySet<number>,
): Promise<EntryOutcome> {
  const { commit } = entry;
  const namespace = commit.namespace;
  // Sent before without an answer, and serve may have pruned its txnId
  // since: whether it landed cannot be told, so it is never sent again.
  if (
    entry.sentMaybeAt !== undefined &&
    clock().getTime() - entry.sentMaybeAt > COMPACTED_TXN_RETENTION_MS
  ) {
    return {
      kind: "rejected",
      reason:
        `possible-duplicate: it was sent at ${
          new Date(entry.sentMaybeAt).toISOString()
        } without an answer, and serve no longer records whether it landed; ` +
        `check the datastore before applying it again`,
    };
  }
  // Under the lease it was queued under first; once serve says that lease
  // has ended or been superseded, under none.
  let leaseId = entry.lease?.leaseId;
  // Cleared when serve will not give this checkout the content a
  // restatement re-puts: the rebased version then takes latest.
  let restate = true;
  const floors = new Map<string, number>();
  for (let attempt = 1;; attempt++) {
    let ops: readonly Op[];
    let outcome: Pick<
      Extract<EntryOutcome, { kind: "landed" }>,
      "renumbered" | "latest" | "carry"
    >;
    let seq: number;
    let built: Commit;
    try {
      await withSpan(
        "swamp.datastore.v3.offline_flush.catch_up",
        {},
        () => port.catchUpPartition(namespace, commit.partition),
      );
      const partition = await port.partitionState(namespace, commit.partition);
      seq = await port.head(namespace, commit.partition);
      const lookups = await withSpan(
        "swamp.datastore.v3.offline_flush.lookups",
        {},
        () =>
          lookupsOf(port, namespace, commit, partition, {
            baseSeq: entry.base.seq,
            flushed,
          }),
      );
      const [rebased] = await asEntryOwn(() =>
        rebaseOfflineCommits([commit], partition, lookups, {
          encodeMetadata: port.encodeMetadata,
          restate,
          carry,
          reserved,
          floor: (name) => floors.get(name) ?? 0,
        })
      );
      if (rebased.kind === "rejected") {
        return {
          kind: "rejected",
          reason: rebased.detail,
          code: rebased.reason,
        };
      }
      ops = rebased.kind === "unchanged"
        ? rebased.commit.ops
        : await opsOf(port, namespace, rebased.changes);
      outcome = rebased.kind === "unchanged"
        ? { renumbered: [], latest: [], carry: EMPTY_REBASE_CARRY }
        : {
          renumbered: rebased.renumbered,
          latest: restate ? rebased.latest : rebased.latest.map(notProvided),
          carry: rebased.carry,
        };
      const sentOps = ops;
      built = await asEntryOwn(() =>
        Promise.resolve(buildCommit(commit, sentOps, seq, options, clock))
      );
    } catch (error) {
      if (error instanceof ServeUnreachableError) return { kind: "stop" };
      throw error;
    }
    try {
      await port.send(built, leaseId);
      return { kind: "landed", ...outcome };
    } catch (error) {
      if (error instanceof ServeUnreachableError) {
        return { kind: "stop", sentMaybe: error.sent === "maybe" };
      }
      if (error instanceof ServeCommitMayLandError) {
        return { kind: "stop", sentMaybe: true };
      }
      if (
        error instanceof ServeUpstreamError &&
        error.code === CHUNK_NOT_PROVIDED
      ) {
        // The restatement re-puts the current latest's content, which serve
        // will not let this checkout name: sent again without it.
        if (
          restate && outcome.latest.some((choice) => choice.kind === "restated")
        ) {
          restate = false;
          continue;
        }
        return { kind: "rejected", reason: error.message };
      }
      if (error instanceof CommitRejectedError) {
        if (error.reason === "seq-gap" && attempt < FLUSH_SEQ_GAP_ATTEMPTS) {
          continue;
        }
        // Serve holds a version the copy's state did not show: a stale basis,
        // not a conflict, so it is rebased above what it sent; it never lands
        // on a version serve holds, since serve refuses one.
        const sent = freshVersionsOf(built.ops);
        if (
          (error.reason === "version-live" ||
            error.reason === "version-reused") && sent.size > 0
        ) {
          if (attempt >= FLUSH_SEQ_GAP_ATTEMPTS) return { kind: "waiting" };
          for (const [name, version] of sent) {
            floors.set(name, Math.max(floors.get(name) ?? 0, version));
          }
          continue;
        }
        // The lease it was queued under has ended or was superseded: sent
        // again under none, rebased on what landed meanwhile.
        if (
          leaseId !== undefined &&
          (error.reason === "lease-lost" || error.reason === "stale-lease")
        ) {
          leaseId = undefined;
          continue;
        }
        if (error.reason === "lease-lost") return { kind: "waiting" };
        return { kind: "rejected", reason: error.message, code: error.reason };
      }
      if (error instanceof ServeCommitRefusedError) {
        if (error.reason === "forbidden") {
          return { kind: "quarantined", reason: error.message };
        }
        return {
          kind: "rejected",
          reason: error.message,
          ...(error.reason === RUN_INITIATOR_MISMATCH_REASON
            ? { code: RUN_INITIATOR_MISMATCH_CODE }
            : {}),
        };
      }
      throw error;
    }
  }
}

/**
 * versions of a data name that the partition's other still-queued entries hold
 * by their queued numbers; this entry's renumbered versions never land on one
 */
function reservedBy(
  entries: readonly OutboxEntry[],
  entry: OutboxEntry,
  flushed: ReadonlySet<string>,
): (name: string) => ReadonlySet<number> {
  return (name) => {
    const reserved = new Set<number>();
    for (const other of entries) {
      if (
        other === entry || flushed.has(other.commit.txnId) ||
        !other.commit.partition.equals(entry.commit.partition)
      ) {
        continue;
      }
      for (const op of other.commit.ops) {
        if (op.kind === "data-version" && op.metadata.name === name) {
          reserved.add(op.metadata.version);
        }
      }
    }
    return reserved;
  };
}

/** the highest version of each name the ops record afresh, not by an append */
function freshVersionsOf(ops: readonly Op[]): Map<string, number> {
  const appended = new Set<string>();
  for (const op of ops) {
    if (op.kind === "put" && op.intent.kind === "data.append") {
      appended.add(JSON.stringify([op.intent.name, op.intent.version]));
    }
  }
  const fresh = new Map<string, number>();
  for (const op of ops) {
    if (op.kind !== "data-version") continue;
    const { name, version } = op.metadata;
    if (appended.has(JSON.stringify([name, version]))) continue;
    fresh.set(name, Math.max(fresh.get(name) ?? 0, version));
  }
  return fresh;
}

const CHUNK_NOT_PROVIDED = "chunk_not_provided";

function notProvided(choice: LatestOutcome): LatestOutcome {
  return choice.kind === "rebased" && choice.restateSkipped === "disabled"
    ? { ...choice, restateSkipped: "content-not-provided" }
    : choice;
}

function buildCommit(
  commit: Commit,
  ops: readonly Op[],
  seq: number,
  options: { readonly writer: CommitWriter; readonly fence: number },
  clock: () => Date,
): Commit {
  return Commit.create({
    seq: seq + 1,
    partition: commit.partition,
    namespace: commit.namespace,
    txnId: commit.txnId,
    writer: options.writer,
    ...(commit.executedAt !== undefined
      ? { executedAt: commit.executedAt }
      : {}),
    ...(commit.clockOffsetMs !== undefined
      ? { clockOffsetMs: commit.clockOffsetMs }
      : {}),
    ...(commit.principal !== undefined ? { principal: commit.principal } : {}),
    fence: options.fence,
    at: clock().toISOString(),
    ops,
  });
}

class OfflineEntryUnbuildableError extends Error {
  constructor(cause: unknown) {
    super(
      `The change cannot be rebuilt for sending: ${messageOf(cause)}`,
      { cause },
    );
    this.name = "OfflineEntryUnbuildableError";
  }
}

/**
 * a failure in this pure rebuild step is the entry's own, unless it is a local
 * I/O failure that may pass
 */
async function asEntryOwn<T>(build: () => Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (error) {
    if (isTransientLocalError(error)) throw error;
    throw new OfflineEntryUnbuildableError(error);
  }
}

function isEntryOwnError(error: unknown): boolean {
  return error instanceof ChunkNotCachedError ||
    error instanceof ChunkIngestError ||
    error instanceof OfflineEntryUnbuildableError;
}

function isTransientLocalError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (Object.values(Deno.errors).some((type) => error instanceof type)) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) ||
    /\(os error \d+\)/.test(error.message);
}

/**
 * only a version the offline writer could not have seen is judged: landed after
 * the entry's base and not this checkout's own offline work; a restatement is
 * never own, since it stands for another writer's version
 */
async function lookupsOf(
  port: OfflineFlushPort,
  namespace: string,
  entryCommit: Commit,
  state: Partition,
  seen: {
    readonly baseSeq: number;
    readonly flushed: ReadonlySet<string>;
    /** the partition's commits read once for a block, with its built ones */
    readonly history?: readonly Commit[];
  },
): Promise<OfflineRebaseLookups> {
  const partition = entryCommit.partition;
  const observations = new Map<string, VersionObservation>();
  const contents = new Map<string, VersionContent>();
  const stored = new Set<string>();
  const own = await port.ownLanded?.(namespace, partition) ?? new Set();
  const history = seen.history ??
    await port.partitionCommits(namespace, partition);
  for (const commit of history) {
    const ownOffline = seen.flushed.has(commit.txnId) || own.has(commit.txnId);
    for (const op of commit.ops) {
      if (op.kind !== "data-version") continue;
      const id = `${op.metadata.name}@${op.metadata.version}`;
      stored.add(id);
      // This checkout's own offline writes were seen by its later offline
      // work; a restatement such a commit carries was not: it stands for
      // another writer's version and competes with that version's time.
      const restatement = restatedVersionOf(op.metadata.tags) !== undefined;
      const sawIt = commit.seq <= seen.baseSeq ||
        (ownOffline && !restatement);
      if (!sawIt) {
        observations.set(id, {
          committedAt: commit.at,
          createdAt: op.metadata.createdAt,
          tags: op.metadata.tags,
        });
      }
      const suffix = `/${op.metadata.name}/${op.metadata.version}/raw`;
      const raw = commit.ops.find((other) =>
        other.kind === "put" && other.key.toString().endsWith(suffix)
      );
      if (raw !== undefined && raw.kind === "put") {
        contents.set(id, {
          raw: raw.content,
          ...(raw.access === undefined ? {} : { rawAccess: raw.access }),
          metadata: op.metadata,
        });
      }
    }
  }
  await addCompactedVersions(port, namespace, entryCommit, state, seen, {
    stored,
    observations,
    contents,
  });
  return {
    observation: (name, version) => observations.get(`${name}@${version}`),
    content: (name, version) => contents.get(`${name}@${version}`),
  };
}

const MAX_COMPACTED_LOOKUPS = 8;

/**
 * Adds what the checkout's files hold of compacted versions the offline
 * writer may not have seen: none when compaction stopped at or before the
 * entry's base, since it saw everything compacted then.
 */
async function addCompactedVersions(
  port: OfflineFlushPort,
  namespace: string,
  entryCommit: Commit,
  state: Partition,
  seen: { readonly baseSeq: number },
  known: {
    readonly stored: ReadonlySet<string>;
    readonly observations: Map<string, VersionObservation>;
    readonly contents: Map<string, VersionContent>;
  },
): Promise<void> {
  if (
    port.compactedThrough === undefined || port.compactedVersion === undefined
  ) {
    return;
  }
  const partition = entryCommit.partition;
  if (await port.compactedThrough(namespace, partition) <= seen.baseSeq) {
    return;
  }
  const names = new Set<string>();
  for (const op of entryCommit.ops) {
    if (op.kind === "data-version") names.add(op.metadata.name);
  }
  for (const name of names) {
    let version = state.latest(name);
    for (
      let hop = 0;
      version !== undefined && hop < MAX_COMPACTED_LOOKUPS;
      hop++
    ) {
      const id = `${name}@${version}`;
      if (known.stored.has(id) || known.observations.has(id)) break;
      const found = await port.compactedVersion(
        namespace,
        partition,
        name,
        version,
      );
      if (found === undefined) break;
      const { metadata } = found;
      known.observations.set(id, {
        createdAt: metadata.createdAt,
        tags: metadata.tags,
      });
      if (found.raw !== undefined) {
        known.contents.set(id, {
          raw: found.raw.length <= MAX_INLINE
            ? { inline: base64Of(found.raw) }
            : { blob: await port.storeChunks(namespace, found.raw) },
          metadata,
        });
      }
      version = restatedVersionOf(metadata.tags);
    }
  }
}

/**
 * a cancelled command or serve refusing the caller, diverging, compacting past
 * the copy or asking for an upgrade stops the flush; other errors reject only
 * the one entry
 */
function stopsTheFlush(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") ||
    error instanceof ServeUpstreamError ||
    error instanceof ServeUpstreamDivergedError ||
    error instanceof ServeUpstreamUpgradeRequiredError ||
    error instanceof ServeNeverReadError ||
    error instanceof CommitsCompactedError;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function opsOf(
  port: OfflineFlushPort,
  namespace: string,
  changes: readonly TypedChange[],
): Promise<Op[]> {
  const ops: Op[] = [];
  for (const change of changes) {
    if ("op" in change) {
      ops.push(change.op);
      continue;
    }
    const { put } = change;
    if (!(put.content instanceof Uint8Array)) {
      throw new Error(
        "Internal error: a rebased offline commit stages bytes only",
      );
    }
    const content = put.content.length <= MAX_INLINE
      ? { inline: base64Of(put.content) }
      : { blob: await port.storeChunks(namespace, put.content) };
    ops.push(
      await putOp({
        intent: put.intent,
        key: put.key,
        ...content,
        ...(put.expect === undefined ? {} : { expect: put.expect }),
        ...(put.access === undefined ? {} : { access: put.access }),
      }),
    );
  }
  return ops;
}

const MAX_INLINE = 8 * 1024;

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function warnRejected(write: RejectedWrite): void {
  if (write.name === undefined) {
    logger
      .warn`A change to ${write.behavior} saved offline did not land: serve refused it and it is kept in this checkout's outbox (txnId ${write.txnId}): ${write.reason} ${write.next}`;
    return;
  }
  logger
    .warn`${write.behavior} ${write.name} version ${write.version}, saved offline, did not land: serve refused it and it is kept in this checkout's outbox (txnId ${write.txnId}): ${write.reason} ${write.next}`;
}

function reportFlush(report: OfflineFlushReport): void {
  if (report.landed > 0) {
    const moved = report.renumbered
      .filter((version) => version.from !== version.to)
      .map((version) =>
        `${version.behavior} ${version.name} ${version.from}→${version.to}`
      );
    logger
      .info`Sent ${report.landed} change(s) this checkout saved while serve was unreachable`;
    if (moved.length > 0) {
      logger
        .info`Versions saved offline were renumbered after what landed meanwhile: ${
        moved.join(", ")
      }`;
    }
    for (const outcome of report.latestAtEnd) {
      if (outcome.kind === "restated") {
        logger
          .info`${outcome.behavior} ${outcome.name}: the latest version stays the one observed last, restated as version ${outcome.version} (its content is version ${outcome.restates}'s)`;
      } else if (outcome.restateSkipped === "content-not-provided") {
        logger
          .info`${outcome.behavior} ${outcome.name}: version ${outcome.version}, saved offline, is now latest, though the version it follows was observed later: serve would not let this checkout restate that version's content`;
      } else if (outcome.restateSkipped !== undefined) {
        logger
          .info`${outcome.behavior} ${outcome.name}: version ${outcome.version}, saved offline, is now latest (${outcome.restateSkipped})`;
      } else {
        logger
          .info`${outcome.behavior} ${outcome.name}: version ${outcome.version}, saved offline, is now latest`;
      }
    }
  }
  if (report.waiting > 0) {
    logger
      .info`${report.waiting} change(s) saved offline are still waiting in this checkout's outbox; a later command sends them`;
  }
}
