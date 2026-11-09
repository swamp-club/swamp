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
 * a commit is built on the higher of the copy's head and serve's last reported
 * head; a commit serve never received is refused (exit 75) and discarded, one
 * that may have reached it keeps its entry
 */

import { latchServeUnreachable } from "./serve_datastore_client.ts";
import { noteCommandLanded } from "./command_landed.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import type { CommitOutbox } from "../../domain/datastore_v3/commit_outbox.ts";
import type { CommitStoreAppendResult } from "../../domain/datastore_v3/commit_store.ts";
import type { DatastoreStorage } from "../../domain/datastore/datastore_storage.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  CommitNotTriedError,
  CommitQueuedOfflineError,
  type SinkBatch,
} from "./commit_log_unit_of_work.ts";
import {
  createOutboxCommitSink,
  type OutboxCommitSink,
} from "./outbox_commit_sink.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type { ServeCatchUp } from "./serve_catch_up.ts";
import {
  type HeldServeLease,
  type LandedVersion,
  noteServeLeaseReleased,
  quietServeLeaseForRelease,
  resumeServeLease,
} from "./serve_lease_registry.ts";
import { storageNamespaceOf } from "./serve_datastore_storage.ts";
import {
  type BatchedCommit,
  type CommitBatchReply,
  type CommitChunk,
  type CommitReply,
  MAX_BATCH_COMMITS,
  type ServeDatastoreClient,
} from "./serve_datastore_client.ts";

import {
  ChunkNotCachedError,
  ServeChunksMissingError,
  ServeCommitMayLandError,
  ServeRateLimitedError,
  ServeStaleSeqError,
  ServeUnreachableError,
  ServeUpstreamDivergedError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";
import { withSpan } from "../tracing/tracer.ts";

const logger = getSwampLogger(["datastore", "v3", "serve"]);

/** chunks one batch carries at most; past it each commit goes alone */
export const MAX_BATCH_CARRIED_BYTES = 64 * 1024 * 1024;

/**
 * chunks a batch that ends the lease may carry: its hold stops renewing for the
 * request, so a larger one keeps renewing and the lease is released after
 */
export const MAX_RELEASE_CARRIED_BYTES = 1024 * 1024;

export const MAX_CARRIED_CHUNKS = 1024;

/**
 * how many times one process uploads a commit's chunks that serve answers
 * with a failure; past it the commit fails at once and stays in the outbox
 */
export const CARRIED_SEND_ATTEMPTS = 3;

/**
 * How many times one flush builds a commit again on a moved head: other
 * writers through serve can move a busy partition more than once.
 */
export const SERVE_SEQ_GAP_ATTEMPTS = 8;

export interface ServeCommitSinkOptions {
  readonly client:
    & Pick<
      ServeDatastoreClient,
      "hasChunks" | "putChunk" | "postCommit" | "baseUrl"
    >
    & Partial<
      Pick<
        ServeDatastoreClient,
        "takesStepStarts" | "postCommits" | "takesCommitBatches"
      >
    >;
  readonly commitStore: Pick<
    SqliteCommitStore,
    "head" | "headIdentity" | "dataHighWater" | "landedSeq"
  >;
  readonly catchUp:
    & Pick<ServeCatchUp, "catchUpPartition" | "headOf" | "recordServeHead">
    & Partial<Pick<ServeCatchUp, "applyStamped">>;
  readonly chunkCache: Pick<DatastoreStorage, "get">;
  readonly outbox: CommitOutbox;
  readonly sweepBatch?: () => Promise<void>;
  readonly signal: () => AbortSignal;
  readonly clock?: () => Date;
  /**
   * the fenced model lease held on a partition, if any: its commits name it,
   * its outbox entries record it, and its floor raises the partition's
   * high-water marks
   */
  readonly leaseOf?: (partition: PartitionKey) => HeldServeLease | undefined;
  readonly dropUnconfirmedLease?: (
    partition: PartitionKey,
    leaseId: string,
  ) => void;
  readonly onLeasedCommit?: (
    partition: PartitionKey,
    leaseId: string,
    landed: readonly LandedVersion[],
  ) => Promise<void>;
  /**
   * undefined while online. Offline, a commit is never sent: it is queued when
   * `queues` allows its partition (the backstop of the offline rules) and
   * refused with the rules' error otherwise
   */
  readonly offline?: () =>
    | {
      readonly queues: (partition: PartitionKey) => Promise<true | Error>;
      readonly noteQueued: (txnId: string) => void;
    }
    | undefined;
}

/**
 * the copy's reads with appends forwarded to serve; outbox recovery lands
 * entries through it too, so a recovered commit reaches serve, never only the
 * copy
 */
export type ServeUpstreamCommitStore =
  & Pick<
    SqliteCommitStore,
    "append" | "head" | "headIdentity" | "dataHighWater" | "landedSeq"
  >
  & {
    /**
     * sends `commit` naming lease `leaseId` or none: a recovery resends an
     * entry under the lease it was built under, not one this process holds now
     */
    appendUnderLease(
      commit: Commit,
      leaseId: string | undefined,
    ): Promise<CommitStoreAppendResult>;
  };

export interface ServeCommitSink extends OutboxCommitSink {
  readonly upstream: ServeUpstreamCommitStore;
}

export function createServeCommitSink(
  options: ServeCommitSinkOptions,
): ServeCommitSink {
  const { client, commitStore, catchUp, chunkCache } = options;
  // The txnIds whose last send serve never received: their recovery need
  // not ask serve, which cannot hold them.
  const neverSent = new Set<string>();

  const chunksOf = async (
    commit: Commit,
    hashes: readonly string[],
  ): Promise<CommitChunk[]> => {
    const chunks: CommitChunk[] = [];
    for (const sha256 of hashes) {
      const bytes = await chunkCache.get(
        storageNamespaceOf(commit.namespace),
        sha256,
        options.signal(),
      );
      if (bytes === null) {
        throw new ChunkNotCachedError(sha256, commit.partition.toString());
      }
      chunks.push({ sha256, bytes });
    }
    return chunks;
  };

  const carriedFailures = new Map<
    string,
    { count: number; error: unknown }
  >();
  const exhaustedFailure = (commit: Commit): { error: unknown } | undefined => {
    const failures = carriedFailures.get(commit.txnId);
    return failures !== undefined && failures.count >= CARRIED_SEND_ATTEMPTS
      ? { error: failures.error }
      : undefined;
  };
  const noteCarriedFailure = (
    commit: Commit,
    chunks: readonly CommitChunk[],
    error: unknown,
  ): void => {
    // a stale seq, a rate limit or a may-land clears on its own: never capped
    if (
      chunks.length === 0 || !(error instanceof ServeUpstreamError) ||
      error instanceof ServeStaleSeqError ||
      error instanceof ServeRateLimitedError ||
      error instanceof ServeCommitMayLandError
    ) {
      return;
    }
    const count = (carriedFailures.get(commit.txnId)?.count ?? 0) + 1;
    carriedFailures.set(commit.txnId, { count, error });
  };

  const carried = async (
    commit: Commit,
    hashes: readonly string[],
  ): Promise<CommitChunk[]> => {
    const signal = options.signal();
    const held = hashes.length === 0
      ? new Set<string>()
      : await client.hasChunks(hashes, signal);
    const missing = hashes.filter((hash) => !held.has(hash));
    const framed = missing.slice(0, MAX_CARRIED_CHUNKS);
    for (const chunk of await chunksOf(commit, missing.slice(framed.length))) {
      await client.putChunk(
        chunk.sha256,
        chunk.bytes,
        signal,
        commit.partition,
      );
    }
    return await chunksOf(commit, framed);
  };

  const leaseOf = options.leaseOf ?? (() => undefined);

  const forward = (
    commit: Commit,
    leaseId: string | undefined,
  ): Promise<CommitStoreAppendResult> =>
    withSpan(
      "swamp.datastore.v3.serve.forward",
      {},
      async () => {
        try {
          return await forwardIn(commit, leaseId);
        } catch (error) {
          if (error instanceof ServeUnreachableError) {
            latchServeUnreachable(client.baseUrl, error);
            if (error.sent === "maybe") {
              noteCommandLanded(
                commit.partition,
                commit.ops.flatMap((op) =>
                  "intent" in op ? [op.intent.kind] : []
                ),
              );
            }
          }
          throw error;
        }
      },
    );

  const envelopeOf = (commit: Commit, leaseId: string | undefined) => {
    const json = commit.toJSON() as { readonly ops: readonly unknown[] };
    // serve stamps the principal, writer and fence, so the envelope names none;
    // a commit under a fenced lease names only the lease id and serve stamps
    // the fence from its own record
    return {
      expectedSeq: commit.seq - 1,
      txnId: commit.txnId,
      ...(leaseId === undefined ? {} : { lease: leaseId }),
      ops: json.ops,
    };
  };

  /** what a refused or failed send means for the copy, then the error to throw */
  const refusedWith = async (
    commit: Commit,
    error: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (error instanceof ServeStaleSeqError) {
      catchUp.recordServeHead(commit.namespace, commit.partition, error.seq);
      try {
        await catchUp.catchUpPartition(
          commit.namespace,
          commit.partition,
          signal,
        );
      } catch (caught) {
        // serve refused the commit, so it never landed: a recovery must not
        // ask the serve that refused it
        if (caught instanceof ServeUpstreamDivergedError) {
          neverSent.add(commit.txnId);
        }
        return caught;
      }
      return new CommitRejectedError(
        "seq-gap",
        `Serve's partition ${commit.partition} is at seq ${error.seq}, ` +
          `past the ${commit.seq - 1} this commit was built on`,
      );
    }
    if (error instanceof ServeUnreachableError && error.sent === "never") {
      neverSent.add(commit.txnId);
    }
    return error;
  };

  /** brings the landed commit into the copy as serve stamped it */
  const landedWith = async (
    commit: Commit,
    leaseId: string | undefined,
    reply: CommitReply,
    signal: AbortSignal,
  ): Promise<CommitStoreAppendResult> => {
    neverSent.delete(commit.txnId);
    carriedFailures.delete(commit.txnId);
    if (leaseId !== undefined && options.onLeasedCommit !== undefined) {
      const landed = commit.ops.flatMap((op) =>
        op.kind === "data-version"
          ? [{ name: op.metadata.name, version: op.metadata.version }]
          : []
      );
      await options.onLeasedCommit(commit.partition, leaseId, landed);
    }
    // The copy stores serve's commit as serve stamped it: from the reply when
    // it can, read back otherwise. A failure here leaves the copy behind; the
    // next catch-up brings it.
    try {
      const applied = reply.commit !== undefined &&
        catchUp.applyStamped !== undefined &&
        await catchUp.applyStamped(
          commit.namespace,
          commit.partition,
          reply.commit,
          reply.parentTxnId,
        );
      if (!applied) {
        await catchUp.catchUpPartition(
          commit.namespace,
          commit.partition,
          signal,
        );
      }
    } catch (error) {
      // the commit is in serve's log either way, so it is not failed; a serve
      // that does not hold the copy's head is warned about now, and the next
      // command refuses it
      if (error instanceof ServeUpstreamDivergedError) {
        logger
          .warn`This change was saved to serve, but serve no longer holds the commits this checkout's copy follows: ${error.message}`;
      }
      catchUp.recordServeHead(commit.namespace, commit.partition, reply.seq);
    }
    return reply.duplicate
      ? { kind: "duplicate", seq: reply.seq }
      : { kind: "appended", seq: reply.seq };
  };

  const forwardIn = async (
    commit: Commit,
    leaseId: string | undefined,
  ): Promise<CommitStoreAppendResult> => {
    const exhausted = exhaustedFailure(commit);
    if (exhausted !== undefined) throw exhausted.error;
    const signal = options.signal();
    const envelope = envelopeOf(commit, leaseId);
    const refs = [...new Set(commit.chunkRefs())];
    let chunks = await carried(commit, refs);
    let reply: CommitReply;
    try {
      try {
        reply = await client.postCommit(
          commit.partition,
          envelope,
          chunks,
          signal,
        );
      } catch (error) {
        // A chunk serve held when asked was collected before the commit:
        // send the named ones once more.
        if (!(error instanceof ServeChunksMissingError)) throw error;
        const named = new Set(error.missing);
        chunks = await chunksOf(commit, refs.filter((hash) => named.has(hash)));
        reply = await client.postCommit(
          commit.partition,
          envelope,
          chunks,
          signal,
        );
      }
    } catch (error) {
      noteCarriedFailure(commit, chunks, error);
      throw await refusedWith(commit, error, signal);
    }
    return await landedWith(commit, leaseId, reply, signal);
  };

  /**
   * the lease the commit is sent under, and how a refusal of an unconfirmed one
   * is handled, as `append` does for a commit sent alone
   */
  const underLease = async (
    commit: Commit,
    lease: HeldServeLease | undefined,
    send: () => Promise<CommitStoreAppendResult>,
  ): Promise<CommitStoreAppendResult> => {
    try {
      return await send();
    } catch (error) {
      // An unconfirmed lease may have ended with a restarted serve, which
      // refused before writing, so resend under no lease. A confirmed lease
      // is kept.
      if (
        lease?.unconfirmed !== true ||
        !(error instanceof CommitRejectedError) ||
        error.reason !== "lease-lost"
      ) {
        throw error;
      }
      options.dropUnconfirmedLease?.(commit.partition, lease.leaseId);
      return await forward(commit, undefined);
    }
  };

  /** one carried-chunk check for every commit of a batch */
  const carriedTogether = async (
    commits: readonly Commit[],
    signal: AbortSignal,
  ): Promise<CommitChunk[][]> => {
    const refsOf = commits.map((commit) => [...new Set(commit.chunkRefs())]);
    const all = [...new Set(refsOf.flat())];
    const held = all.length === 0
      ? new Set<string>()
      : await client.hasChunks(all, signal);
    const framed: CommitChunk[][] = [];
    for (const [index, commit] of commits.entries()) {
      const missing = refsOf[index].filter((hash) => !held.has(hash));
      const inFrame = missing.slice(0, MAX_CARRIED_CHUNKS);
      for (
        const chunk of await chunksOf(commit, missing.slice(inFrame.length))
      ) {
        await client.putChunk(
          chunk.sha256,
          chunk.bytes,
          signal,
          commit.partition,
        );
      }
      framed.push(await chunksOf(commit, inFrame));
    }
    return framed;
  };

  interface Waiting {
    readonly commit: Commit;
    readonly lease: HeldServeLease | undefined;
    readonly resolve: (result: CommitStoreAppendResult) => void;
    readonly reject: (error: unknown) => void;
  }

  /** in order, each alone; a commit after one that did not land is not tried */
  const sendAlone = async (waiting: readonly Waiting[]): Promise<void> => {
    let stopped = false;
    for (const entry of waiting) {
      if (stopped) {
        neverSent.add(entry.commit.txnId);
        entry.reject(
          new CommitNotTriedError(entry.commit.partition.toString()),
        );
        continue;
      }
      try {
        entry.resolve(
          await underLease(
            entry.commit,
            entry.lease,
            () => forward(entry.commit, entry.lease?.leaseId),
          ),
        );
      } catch (error) {
        stopped = true;
        entry.reject(error);
      }
    }
  };

  const sendBatch = async (
    waiting: readonly Waiting[],
    release: string | undefined,
  ): Promise<void> => {
    if (waiting.length === 0) return;
    // one commit and nothing to end goes on the single route, as does one
    // that has used up its uploads: alone, it fails without sending
    if (
      (waiting.length === 1 && release === undefined) ||
      waiting.some((entry) => exhaustedFailure(entry.commit) !== undefined)
    ) {
      await sendAlone(waiting);
      return;
    }
    const signal = options.signal();
    let batch: CommitBatchReply | undefined;
    let sentChunks: CommitChunk[][] = [];
    let quieted: string | undefined;
    try {
      batch = await withSpan(
        "swamp.datastore.v3.serve.forward_batch",
        { "swamp.datastore.v3.commits": waiting.length },
        async () => {
          const chunks = await carriedTogether(
            waiting.map((entry) => entry.commit),
            signal,
          );
          sentChunks = chunks;
          const carriedBytes = chunks.flat().reduce(
            (total, chunk) => total + chunk.bytes.byteLength,
            0,
          );
          if (carriedBytes > MAX_BATCH_CARRIED_BYTES) return undefined;
          // the hold renews through every upload: it is quieted only for a
          // small request, just before it goes, since serve may end the lease
          if (
            release !== undefined &&
            carriedBytes <= MAX_RELEASE_CARRIED_BYTES &&
            await quietServeLeaseForRelease(release)
          ) {
            quieted = release;
          }
          if (waiting.length === 1 && quieted === undefined) return undefined;
          const commits: BatchedCommit[] = waiting.map((entry, index) => ({
            partition: entry.commit.partition,
            envelope: envelopeOf(entry.commit, entry.lease?.leaseId),
            chunks: chunks[index],
          }));
          return await client.postCommits!(commits, quieted, signal);
        },
      );
    } catch (error) {
      // a release that may have reached serve is not renewed again
      const mayHaveEnded = error instanceof ServeUnreachableError &&
        error.sent === "maybe";
      if (quieted !== undefined && !mayHaveEnded) resumeServeLease(quieted);
      // a follower older than its leader has no batch route
      if (
        error instanceof ServeUpstreamError &&
        (error.status === 404 || error.status === 405)
      ) {
        await sendAlone(waiting);
        return;
      }
      if (error instanceof ServeUnreachableError) {
        latchServeUnreachable(client.baseUrl, error);
      }
      for (const [index, entry] of waiting.entries()) {
        noteCarriedFailure(entry.commit, sentChunks[index] ?? [], error);
        if (mayHaveEnded) {
          noteCommandLanded(
            entry.commit.partition,
            entry.commit.ops.flatMap((op) =>
              "intent" in op ? [op.intent.kind] : []
            ),
          );
        }
        entry.reject(await refusedWith(entry.commit, error, signal));
      }
      return;
    }
    if (quieted !== undefined) {
      if (batch?.released === true) noteServeLeaseReleased(quieted);
      else resumeServeLease(quieted);
    }
    if (batch === undefined) {
      await sendAlone(waiting);
      return;
    }
    // In order, as each would have been sent alone: a commit's landing is in
    // the copy before the next is looked at.
    for (const [index, entry] of waiting.entries()) {
      const outcome = batch.outcomes[index];
      try {
        if (outcome.kind === "landed") {
          entry.resolve(
            await landedWith(
              entry.commit,
              entry.lease?.leaseId,
              outcome.reply,
              signal,
            ),
          );
        } else if (outcome.kind === "not-tried") {
          neverSent.add(entry.commit.txnId);
          entry.reject(
            new CommitNotTriedError(entry.commit.partition.toString()),
          );
        } else if (outcome.error instanceof ServeChunksMissingError) {
          // as the single route resends them: alone, once
          entry.resolve(
            await underLease(
              entry.commit,
              entry.lease,
              () => forward(entry.commit, entry.lease?.leaseId),
            ),
          );
        } else {
          const error = outcome.error;
          noteCarriedFailure(entry.commit, sentChunks[index] ?? [], error);
          entry.resolve(
            await underLease(entry.commit, entry.lease, async () => {
              throw await refusedWith(entry.commit, error, signal);
            }),
          );
        }
      } catch (error) {
        entry.reject(error);
      }
    }
  };

  // One batch at a time: each of its commits holds its partition's lock until
  // the batch is sent, so two filling at once could each wait on the other.
  let batchGate: Promise<void> = Promise.resolve();

  const beginBatch = async (
    slots: number,
    batchOptions?: { readonly release?: string },
  ): Promise<SinkBatch | undefined> => {
    if (
      slots < 1 || slots > MAX_BATCH_COMMITS ||
      client.postCommits === undefined ||
      client.takesCommitBatches?.() !== true ||
      options.offline?.() !== undefined ||
      (slots === 1 && batchOptions?.release === undefined)
    ) {
      return undefined;
    }
    const previous = batchGate;
    let open!: () => void;
    batchGate = new Promise<void>((resolve) => open = resolve);
    await previous;
    const entries: (Waiting | "skipped" | undefined)[] = new Array(slots);
    let settled = 0;
    const settle = async () => {
      if (++settled < slots) return;
      try {
        await sendBatch(
          entries.filter((entry): entry is Waiting =>
            entry !== undefined && entry !== "skipped"
          ),
          batchOptions?.release,
        );
      } finally {
        open();
      }
    };
    return {
      async append(slot, commit) {
        // offline, a commit is only queued, never sent: alone
        if (options.offline?.() !== undefined) {
          entries[slot] = "skipped";
          await settle();
          return await upstream.append(commit);
        }
        const result = new Promise<CommitStoreAppendResult>(
          (resolve, reject) => {
            entries[slot] = {
              commit,
              lease: leaseOf(commit.partition),
              resolve,
              reject,
            };
          },
        );
        await settle();
        return await result;
      },
      async skip(slot) {
        entries[slot] = "skipped";
        await settle();
      },
    };
  };

  const head = async (namespace: string, partition: PartitionKey) => {
    const local = await commitStore.head(namespace, partition);
    return {
      seq: await catchUp.headOf(namespace, partition),
      highestFence: local.highestFence,
    };
  };

  const upstream: ServeUpstreamCommitStore = {
    head,
    headIdentity: async (namespace, partition) => {
      const local = await commitStore.headIdentity(namespace, partition);
      const seq = await catchUp.headOf(namespace, partition);
      return seq > local.seq ? { seq, txnId: undefined } : local;
    },
    // a fenced lease's floor holds versions from commits the caller cannot
    // read, and versions queued offline are not in the copy; allocating above
    // both keeps offline commands from sharing a version
    dataHighWater: async (namespace, partition, name) => {
      const copy = await commitStore.dataHighWater(namespace, partition, name);
      const floor = leaseOf(partition)?.floor.find((marks) =>
        marks.name === name
      );
      const queued = await options.outbox.queuedDataHighWater(
        namespace,
        partition.toString(),
        name,
      );
      return Math.max(copy, floor?.highWater ?? 0, queued);
    },
    landedSeq: async (namespace, partition, txnId) => {
      const local = await commitStore.landedSeq(namespace, partition, txnId);
      if (local !== undefined || neverSent.delete(txnId)) return local;
      // offline, nothing was sent, so serve cannot hold it
      if (options.offline?.() !== undefined) return local;
      // It may have landed at serve after the reply was lost: read the
      // partition. A failure is the caller's: the commit may land later.
      await catchUp.catchUpPartition(namespace, partition, options.signal());
      return await commitStore.landedSeq(namespace, partition, txnId);
    },
    append: async (commit) => {
      // offline for the rest of the command: never sent, only queued, and only
      // where the offline rules allow
      const offline = options.offline?.();
      if (offline !== undefined) {
        const verdict = await offline.queues(commit.partition);
        if (verdict !== true) throw verdict;
        offline.noteQueued(commit.txnId);
        throw new CommitQueuedOfflineError(commit.partition);
      }
      const lease = leaseOf(commit.partition);
      return await underLease(
        commit,
        lease,
        () => forward(commit, lease?.leaseId),
      );
    },
    appendUnderLease: forward,
  };
  const sink = createOutboxCommitSink({
    commitStore: upstream,
    outbox: options.outbox,
    ...(options.sweepBatch !== undefined
      ? { sweepBatch: options.sweepBatch }
      : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  return {
    ...sink,
    outbox: sink.outbox === undefined ? undefined : {
      ...sink.outbox,
      // the entry records the lease it was built under, which its recovery
      // names
      prepare: (preparation) => {
        const lease = leaseOf(preparation.commit.partition);
        return sink.outbox!.prepare(
          lease === undefined ? preparation : {
            ...preparation,
            lease: { leaseId: lease.leaseId, fence: lease.fence },
          },
        );
      },
    },
    seqGapAttempts: SERVE_SEQ_GAP_ATTEMPTS,
    beginBatch,
    batchLimit: MAX_BATCH_COMMITS,
    takesStepStarts: () => client.takesStepStarts?.() ?? false,
    queuesOffline: async (partition) => {
      const offline = options.offline?.();
      return offline !== undefined && await offline.queues(partition) === true;
    },
    upstream,
  };
}
