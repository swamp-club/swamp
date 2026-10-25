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
 * Commits a forwarded commit: one a client built and serve authorised
 * (swamp-club#3915). Serve's own writer appends it, under the partition's
 * lock and through the outbox, with serve's writer, fence and namespace; the
 * client supplies only the partition, its txnId, the head it built on and
 * the ops. The caller is stamped as the commit's principal.
 *
 * A retry under the same txnId lands once: a txnId that already landed
 * answers with its seq, when the landed commit is the same one from the same
 * caller, and is refused otherwise.
 *
 * @module
 */

import {
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import type { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  CommitsCompactedError,
  type CommitStore,
} from "../../domain/datastore_v3/commit_store.ts";
import type { Op } from "../../domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { WriterFencedError } from "../../domain/datastore_v3/writer_lease.ts";
import { StaleSeqError } from "./commit_log_unit_of_work.ts";

export { StaleSeqError };
import type { V3Datastore } from "./v3_datastore.ts";

/** What serve hands over to commit, after authorising it. */
export interface ForwardedCommitRequest {
  readonly partition: PartitionKey;
  readonly txnId: string;
  readonly expectedSeq: number;
  /**
   * The fence the client believes the writer holds, if it sent one: a
   * mismatch means serve's writer changed under it.
   */
  readonly fence?: number;
  /** The authenticated caller, as serve names it. */
  readonly principal: string;
  readonly ops: readonly Op[];
}

/** A landed forwarded commit. */
export interface ForwardedCommitResult {
  readonly seq: number;
  /** True when an earlier attempt under the same txnId had landed it. */
  readonly duplicate: boolean;
}

/** The parts of a v3 handle a forwarded commit uses. */
export type ForwardedCommitTarget =
  & Pick<
    V3Datastore,
    "appendForwarded" | "chunkStore" | "namespace" | "writerFence"
  >
  & {
    readonly commitStore: Pick<CommitStore, "readPartition" | "head"> & {
      landedSeq(
        namespace: string,
        partition: PartitionKey,
        txnId: string,
      ): Promise<number | undefined>;
    };
  };

/**
 * A forwarded commit's precondition failed: the record changed since the
 * client read it. `changedBy` and `changedAt` name the newest commit that
 * touched the key, when it is recent enough to find.
 */
export class PreconditionConflictError extends Error {
  readonly code = "precondition_failed";
  constructor(
    readonly key: string,
    /** The partition's head now. */
    readonly seq: number,
    readonly changedBy: string | undefined,
    readonly changedAt: string | undefined,
  ) {
    super(
      `${key} was changed${changedBy === undefined ? "" : ` by ${changedBy}`}` +
        `${changedAt === undefined ? "" : ` at ${changedAt}`} since you read ` +
        `it (seq ${seq}): catch up, then apply your change again`,
    );
    this.name = "PreconditionConflictError";
  }
}

/** A txnId that landed as another commit, or for another caller. */
export class TxnIdReusedError extends Error {
  readonly code = "txn_id_reused";
  constructor(readonly txnId: string) {
    super(`Transaction ${txnId} already landed as a different commit`);
    this.name = "TxnIdReusedError";
  }
}

/** Chunks a forwarded commit names that the store does not hold. */
export class ChunksMissingError extends Error {
  readonly code = "chunk_not_provided";
  constructor(readonly missing: readonly string[]) {
    super(
      `The commit names ${missing.length} chunk(s) the server does not ` +
        `hold; upload them first`,
    );
    this.name = "ChunksMissingError";
  }
}

/** How many commits back the newest change to a refused key is looked for. */
const CHANGED_BY_SCAN = 200;

/**
 * Commits `request` through `v3`'s writer and resolves with its seq.
 *
 * @throws StaleSeqError when the partition's head is not `expectedSeq`
 * @throws PreconditionConflictError when an op's `expect` fails
 * @throws TxnIdReusedError when the txnId landed as another commit
 * @throws ChunksMissingError when a named chunk is not stored
 * @throws WriterFencedError when the client's fence is not the writer's
 * @throws CommitRejectedError for any other refusal of the partition
 */
export async function commitForwarded(
  v3: ForwardedCommitTarget,
  request: ForwardedCommitRequest,
  signal: AbortSignal,
): Promise<ForwardedCommitResult> {
  const landed = await landedResult(v3, request);
  if (landed !== undefined) return landed;
  const fence = v3.writerFence();
  if (request.fence !== undefined && request.fence !== fence) {
    throw new WriterFencedError(request.fence, fence);
  }
  // Refreshing the chunks restarts their garbage-collection grace, so none
  // is swept between this check and the append.
  const missing = await missingChunks(
    v3.chunkStore,
    v3.namespace,
    request.ops,
    signal,
  );
  if (missing.length > 0) throw new ChunksMissingError(missing);
  try {
    await v3.appendForwarded({
      partition: request.partition,
      txnId: request.txnId,
      expectedSeq: request.expectedSeq,
      principal: request.principal,
      ops: request.ops,
    });
  } catch (error) {
    // Two attempts of one commit in flight: the second finds the head moved
    // by the first.
    if (error instanceof StaleSeqError) {
      const raced = await landedResult(v3, request);
      if (raced !== undefined) return raced;
    }
    if (
      error instanceof CommitRejectedError && error.reason === "expect-failed"
    ) {
      throw await preconditionConflict(v3, request.partition, error);
    }
    throw error;
  }
  const result = await landedResult(v3, request);
  if (result === undefined) {
    throw new Error(
      `Forwarded commit ${request.txnId} was appended but its seq cannot be read`,
    );
  }
  return { seq: result.seq, duplicate: false };
}

/**
 * The seq `request`'s txnId landed at, when it did, as a duplicate: refused
 * when the landed commit is another caller's or holds other ops.
 */
async function landedResult(
  v3: ForwardedCommitTarget,
  request: ForwardedCommitRequest,
): Promise<ForwardedCommitResult | undefined> {
  const seq = await v3.commitStore.landedSeq(
    v3.namespace,
    request.partition,
    request.txnId,
  );
  if (seq === undefined) return undefined;
  let commit: Commit | undefined;
  try {
    [commit] = (await v3.commitStore.readPartition(
      v3.namespace,
      request.partition,
      seq,
      1,
    )).map((change) => change.commit);
  } catch (error) {
    // Compacted away: its ops can no longer be compared, so the txnId
    // cannot be honoured as the same commit.
    if (error instanceof CommitsCompactedError) {
      throw new TxnIdReusedError(request.txnId);
    }
    throw error;
  }
  if (
    commit === undefined || commit.txnId !== request.txnId ||
    commit.principal !== request.principal ||
    JSON.stringify(commit.ops.map((op) => op.toJSON())) !==
      JSON.stringify(request.ops.map((op) => op.toJSON()))
  ) {
    throw new TxnIdReusedError(request.txnId);
  }
  return { seq, duplicate: true };
}

async function missingChunks(
  chunks: ChunkStore,
  namespace: string,
  ops: readonly Op[],
  signal: AbortSignal,
): Promise<string[]> {
  const ns = namespace === "" ? SOLO_NAMESPACE : restoreNamespace(namespace);
  const missing = new Set<string>();
  for (const op of ops) {
    if (op.kind !== "put" || !("blob" in op.content)) continue;
    for (const sha256 of await chunks.refresh(ns, op.content.blob, signal)) {
      missing.add(sha256);
    }
  }
  return [...missing];
}

/**
 * The conflict reply of a failed precondition: the key, the head, and the
 * newest of the last {@link CHANGED_BY_SCAN} commits that touched the key.
 */
async function preconditionConflict(
  v3: ForwardedCommitTarget,
  partition: PartitionKey,
  error: CommitRejectedError,
): Promise<Error> {
  const key = error.key?.toString();
  if (key === undefined) return error;
  const head = await v3.commitStore.head(v3.namespace, partition);
  let changedBy: string | undefined;
  let changedAt: string | undefined;
  try {
    const recent = await v3.commitStore.readPartition(
      v3.namespace,
      partition,
      Math.max(1, head.seq - CHANGED_BY_SCAN + 1),
      CHANGED_BY_SCAN,
    );
    for (const { commit } of [...recent].reverse()) {
      const touched = commit.ops.some((op) =>
        (op.kind === "put" || op.kind === "tombstone") &&
        op.key.toString() === key
      );
      if (!touched) continue;
      changedBy = commit.principal ?? commit.writer.host;
      changedAt = commit.at;
      break;
    }
  } catch (readError) {
    if (!(readError instanceof CommitsCompactedError)) throw readError;
  }
  return new PreconditionConflictError(key, head.seq, changedBy, changedAt);
}
