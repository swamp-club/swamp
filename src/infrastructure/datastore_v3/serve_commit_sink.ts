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
 * The commit sink of a v3 checkout whose upstream is serve
 * (swamp-club#3985). It is the outbox sink of `outbox_commit_sink.ts` over
 * a commit store that forwards each commit to serve's
 * `POST partitions/{p}/commits` instead of appending it here: the outbox
 * still makes each commit durable until it landed, and the units above it
 * are unchanged.
 *
 * - **Head.** A commit is built on the higher of the copy's head and the
 *   head serve last reported: serve may hold commits this caller cannot
 *   read.
 * - **Chunks.** Serve is asked which of the commit's chunks it holds. Up to
 *   {@link MAX_CARRIED_CHUNKS} missing ones ride in the commit's frame,
 *   from the checkout's chunk cache; any more go first as
 *   `PUT chunks/{sha256}?partition=`, so no upload ever needs `admin`.
 * - **Landing.** Serve's reply (`{seq}`, or a duplicate's) lands the commit;
 *   the copy then reads the partition from serve, so it stores serve's
 *   stamped commit, never the one built here.
 * - **Stale seq.** Serve's head is recorded and the partition read, then the
 *   append is refused as a seq gap: the unit builds the commit again on the
 *   new head under the same txnId.
 * - **Unreachable.** A commit serve never received is refused with exit 75
 *   and its outbox entry discarded: nothing changed. One that may have
 *   reached serve keeps its entry, so the next recovery settles or sends it.
 *   Storage is never written instead.
 *
 * @module
 */

import type { Commit } from "../../domain/datastore_v3/commit.ts";
import type { CommitOutbox } from "../../domain/datastore_v3/commit_outbox.ts";
import type { CommitStoreAppendResult } from "../../domain/datastore_v3/commit_store.ts";
import type { DatastoreStorage } from "../../domain/datastore/datastore_storage.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { CommitQueuedOfflineError } from "./commit_log_unit_of_work.ts";
import {
  createOutboxCommitSink,
  type OutboxCommitSink,
} from "./outbox_commit_sink.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type { ServeCatchUp } from "./serve_catch_up.ts";
import type { HeldServeLease, LandedVersion } from "./serve_lease_registry.ts";
import { storageNamespaceOf } from "./serve_datastore_storage.ts";
import type {
  CommitChunk,
  ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import {
  ChunkNotCachedError,
  ServeChunksMissingError,
  ServeStaleSeqError,
  ServeUnreachableError,
  ServeUpstreamDivergedError,
} from "./serve_upstream_errors.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";

const logger = getSwampLogger(["datastore", "v3", "serve"]);

/** The most chunks one commit request carries; serve's own limit. */
export const MAX_CARRIED_CHUNKS = 1024;

/**
 * How many times one flush builds a commit again on a moved head: other
 * writers through serve can move a busy partition more than once.
 */
export const SERVE_SEQ_GAP_ATTEMPTS = 8;

/** What {@link createServeCommitSink} composes. */
export interface ServeCommitSinkOptions {
  readonly client: Pick<
    ServeDatastoreClient,
    "hasChunks" | "putChunk" | "postCommit" | "baseUrl"
  >;
  /** The checkout's follower copy of serve's log. */
  readonly commitStore: Pick<
    SqliteCommitStore,
    "head" | "headIdentity" | "dataHighWater" | "landedSeq"
  >;
  readonly catchUp: Pick<
    ServeCatchUp,
    "catchUpPartition" | "headOf" | "recordServeHead"
  >;
  /** The checkout's chunk cache, which every put of a unit lands in. */
  readonly chunkCache: Pick<DatastoreStorage, "get">;
  readonly outbox: CommitOutbox;
  readonly sweepBatch?: () => Promise<void>;
  /** Bounds every request; aborted when the handle closes. */
  readonly signal: () => AbortSignal;
  readonly clock?: () => Date;
  /**
   * The fenced model lease this process holds on a partition, if any
   * (swamp-club#4121): its commits name it, its outbox entries record it,
   * and its floor raises the partition's high-water marks.
   */
  readonly leaseOf?: (partition: PartitionKey) => HeldServeLease | undefined;
  /**
   * Forgets the unconfirmed lease `leaseId` on `partition` once serve has
   * refused a commit under it (swamp-club#4167).
   */
  readonly dropUnconfirmedLease?: (
    partition: PartitionKey,
    leaseId: string,
  ) => void;
  /**
   * Called once a commit naming lease `leaseId` has landed, with the data
   * versions it recorded, so the lease's floor follows the holder's own
   * writes (swamp-club#4121). A failure is the callback's to report.
   */
  readonly onLeasedCommit?: (
    partition: PartitionKey,
    leaseId: string,
    landed: readonly LandedVersion[],
  ) => Promise<void>;
  /**
   * The checkout's offline mode (swamp-club#4195): undefined while online.
   * Offline, a commit is never sent; it is queued in the outbox when
   * `queues` allows its partition (the backstop of the offline rules), and
   * refused with the rules' error otherwise.
   */
  readonly offline?: () =>
    | {
      readonly queues: (partition: PartitionKey) => Promise<true | Error>;
      readonly noteQueued: (txnId: string) => void;
    }
    | undefined;
}

/**
 * The commit store the serve sink's outbox sink composes: the copy's reads,
 * with appends forwarded to serve. Outbox recovery lands its entries
 * through it too, so a recovered commit reaches serve, never only the copy.
 */
export type ServeUpstreamCommitStore =
  & Pick<
    SqliteCommitStore,
    "append" | "head" | "headIdentity" | "dataHighWater" | "landedSeq"
  >
  & {
    /**
     * Sends `commit` naming the model lease `leaseId`, or none: what a
     * recovery resends an outbox entry under, the lease it was built
     * under rather than any this process holds now (swamp-club#4121).
     */
    appendUnderLease(
      commit: Commit,
      leaseId: string | undefined,
    ): Promise<CommitStoreAppendResult>;
  };

/** A serve-mode handle's sink, and the store its outbox recovery uses. */
export interface ServeCommitSink extends OutboxCommitSink {
  readonly upstream: ServeUpstreamCommitStore;
}

/** Builds the sink a serve-mode v3 handle gives every unit it opens. */
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

  /** The commit's chunks serve lacks, uploading any past the frame's cap. */
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

  const forward = async (
    commit: Commit,
    leaseId: string | undefined,
  ): Promise<CommitStoreAppendResult> => {
    const signal = options.signal();
    const json = commit.toJSON() as { readonly ops: readonly unknown[] };
    // Serve stamps the principal, writer and fence: the envelope names
    // none. A commit made under a fenced lease names the lease's id; serve
    // stamps its fence from its own record (swamp-club#4121).
    const envelope = {
      expectedSeq: commit.seq - 1,
      txnId: commit.txnId,
      ...(leaseId === undefined ? {} : { lease: leaseId }),
      ops: json.ops,
    };
    const refs = [...new Set(commit.chunkRefs())];
    let chunks = await carried(commit, refs);
    let reply;
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
      if (error instanceof ServeStaleSeqError) {
        catchUp.recordServeHead(commit.namespace, commit.partition, error.seq);
        try {
          await catchUp.catchUpPartition(
            commit.namespace,
            commit.partition,
            signal,
          );
        } catch (caught) {
          // Serve refused the commit, so it never landed: a recovery must
          // not ask the serve it refused for it (swamp-club#4049).
          if (caught instanceof ServeUpstreamDivergedError) {
            neverSent.add(commit.txnId);
          }
          throw caught;
        }
        throw new CommitRejectedError(
          "seq-gap",
          `Serve's partition ${commit.partition} is at seq ${error.seq}, ` +
            `past the ${commit.seq - 1} this commit was built on`,
        );
      }
      if (error instanceof ServeUnreachableError && error.sent === "never") {
        neverSent.add(commit.txnId);
      }
      throw error;
    }
    neverSent.delete(commit.txnId);
    if (leaseId !== undefined && options.onLeasedCommit !== undefined) {
      const landed = commit.ops.flatMap((op) =>
        op.kind === "data-version"
          ? [{ name: op.metadata.name, version: op.metadata.version }]
          : []
      );
      await options.onLeasedCommit(commit.partition, leaseId, landed);
    }
    // The copy stores serve's commit as serve stamped it. A read that fails
    // here leaves the copy behind; the next catch-up brings it.
    try {
      await catchUp.catchUpPartition(
        commit.namespace,
        commit.partition,
        signal,
      );
    } catch (error) {
      // The commit is in serve's log either way: it is not failed. A serve
      // that no longer holds the copy's head is said now, though, since
      // this commit landed in a log the copy does not follow
      // (swamp-club#4049); the next command refuses it.
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
    // A fenced lease's floor holds versions the copy may not: ones written
    // by commits the caller cannot read (swamp-club#4121). Versions queued
    // offline are not in the copy either: a command allocates above them
    // too, so two offline commands never share one (swamp-club#4195).
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
      // Offline, nothing was sent (swamp-club#4195): serve cannot hold it.
      if (options.offline?.() !== undefined) return local;
      // It may have landed at serve after the reply was lost: read the
      // partition. A failure is the caller's: the commit may land later.
      await catchUp.catchUpPartition(namespace, partition, options.signal());
      return await commitStore.landedSeq(namespace, partition, txnId);
    },
    append: async (commit) => {
      // Offline for the rest of the command (swamp-club#4195): never sent,
      // only queued, and only where the offline rules allow.
      const offline = options.offline?.();
      if (offline !== undefined) {
        const verdict = await offline.queues(commit.partition);
        if (verdict !== true) throw verdict;
        offline.noteQueued(commit.txnId);
        throw new CommitQueuedOfflineError(commit.partition);
      }
      const lease = leaseOf(commit.partition);
      try {
        return await forward(commit, lease?.leaseId);
      } catch (error) {
        // A lease registered from the checkout's record, which serve has
        // not vouched for in this process, may have ended with a serve
        // that restarted (swamp-club#4167). Serve refused the commit before
        // writing it, so it is sent again under no lease, which serve
        // refuses only while another holder's lease covers the partition,
        // as an outbox recovery does. A lease serve vouched for is never
        // dropped: a commit refused under it is the caller's.
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
      // The entry records the lease it was built under, which its
      // recovery names (swamp-club#4121).
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
    queuesOffline: async (partition) => {
      const offline = options.offline?.();
      return offline !== undefined && await offline.queues(partition) === true;
    },
    upstream,
  };
}
