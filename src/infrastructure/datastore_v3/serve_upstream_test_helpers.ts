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
 * An in-memory serve datastore API for the serve-mode checkout's unit tests
 * (swamp-club#3985): serve's authoritative log with contiguous seqs, a
 * per-caller visibility filter, stamped commits, paged reads and the
 * refusals a commit request can meet.
 *
 * @module
 */

import { Commit, type CommitJSON } from "../../domain/datastore_v3/commit.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import {
  type ChangesPage,
  type CommitChunk,
  type CommitEnvelope,
  type CommitReply,
  type PartitionCommitsPage,
  SERVE_PAGE_MAX_BYTES,
  type ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import {
  ServeChunksMissingError,
  ServeCommitsCompactedError,
  ServeReplyTooLargeError,
  ServeStaleSeqError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";

export const SERVE_URL = "http://serve.test:9090";
export const SERVE_WRITER = {
  host: "serve-host",
  pid: 1,
  instance: "serve",
} as const;
export const SERVE_PRINCIPAL = "alice@example.com";
export const SERVE_FENCE = 7;
export const SERVE_AT = "2026-10-27T00:00:00.000Z";

/** The most commits serve answers in one page, as `MAX_PAGE` is. */
export const FAKE_SERVE_MAX_PAGE = 1000;

/** One commit of serve's log; `json` undefined for one no caller reads. */
interface LogEntry {
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
  readonly json: CommitJSON | undefined;
}

/** A commit request as serve received it. */
export interface PostedCommit {
  readonly partition: string;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly chunks: readonly string[];
}

/** What the next commit request meets. */
export type PostFault =
  /** No connection was made: serve changed nothing. */
  | { readonly kind: "never" }
  /** Serve landed the commit and the reply was lost. */
  | { readonly kind: "maybe" }
  /** Serve's GC collected these chunks between `has` and the commit. */
  | { readonly kind: "collect"; readonly hashes: readonly string[] };

type Client = Pick<
  ServeDatastoreClient,
  | "baseUrl"
  | "namespace"
  | "changes"
  | "partitionCommits"
  | "postCommit"
  | "hasChunks"
  | "putChunk"
  | "getChunk"
>;

/** Serve's datastore API held in memory; see the module doc. */
export class FakeServe implements Client {
  readonly baseUrl = SERVE_URL;
  readonly namespace: string;
  readonly feed: LogEntry[] = [];
  readonly logs = new Map<string, LogEntry[]>();
  /** The txnIds of commits the caller may not read. */
  readonly hidden = new Set<string>();
  readonly chunks = new Map<string, Uint8Array>();
  /** Commits per changes page. */
  feedPageSize = FAKE_SERVE_MAX_PAGE;
  readonly requests = {
    changes: 0,
    partitionCommits: 0,
    postCommit: 0,
    hasChunks: 0,
    putChunk: 0,
    getChunk: 0,
  };
  readonly posted: PostedCommit[] = [];
  readonly uploads: { sha256: string; partition: string | undefined }[] = [];
  readonly hasAsked: string[][] = [];
  readonly partitionReads: { after: number; limit: number | undefined }[] = [];
  readonly changesReads: { cursor: number; limit: number | undefined }[] = [];
  /**
   * Answers a page read as too large for the client to read while it
   * returns true for the read's route and limit.
   */
  tooLarge:
    | ((route: "changes" | "partition", limit: number | undefined) => boolean)
    | undefined;
  readonly postFaults: PostFault[] = [];
  /** Runs before each commit request is acted on: another writer, say. */
  beforePost: (() => Promise<void>) | undefined;
  /** Thrown by the next `changes` requests while set. */
  changesFault: Error | undefined;
  /** How many of the next partition reads fail as unreachable. */
  partitionFaults = 0;
  /** The seq each partition is compacted through: a read from it is a 410. */
  readonly compactedThrough = new Map<string, number>();
  /** Partitions this caller may not read: a read of one is a 404. */
  readonly unreadablePartitions = new Set<string>();
  /** Awaited at the start of every `changes` request. */
  changesGate: Promise<void> | undefined;

  constructor(namespace = "_default") {
    this.namespace = namespace;
  }

  /** Serve's head of `partition`. */
  head(partition: PartitionKey): number {
    return this.#log(partition.toString()).length;
  }

  /**
   * Lands a commit another caller wrote, as serve stamped it: its seq must
   * be serve's head + 1. Hidden from this caller with `hidden`.
   */
  land(commit: Commit, options: { hidden?: boolean } = {}): void {
    const key = commit.partition.toString();
    const log = this.#log(key);
    if (commit.seq !== log.length + 1) {
      throw new Error(
        `fake serve: seq ${commit.seq} is not past head ${log.length}`,
      );
    }
    this.#push({
      partition: key,
      seq: commit.seq,
      txnId: commit.txnId,
      json: commit.toJSON(),
    });
    if (options.hidden === true) this.hidden.add(commit.txnId);
  }

  /** Lands `count` commits no caller may read, cheaply. */
  landUnreadable(partition: PartitionKey, count: number): void {
    const key = partition.toString();
    const log = this.#log(key);
    for (let i = 0; i < count; i++) {
      const seq = log.length + 1;
      this.#push({
        partition: key,
        seq,
        txnId: `unreadable-${key}-${seq}`,
        json: undefined,
      });
    }
  }

  async changes(
    cursor: number,
    signal: AbortSignal,
    limit?: number,
  ): Promise<ChangesPage> {
    this.requests.changes++;
    this.changesReads.push({ cursor, limit });
    if (this.changesGate !== undefined) await this.changesGate;
    signal.throwIfAborted();
    if (this.changesFault !== undefined) throw this.changesFault;
    if (this.tooLarge?.("changes", limit) === true) {
      throw new ServeReplyTooLargeError(200, "changes", SERVE_PAGE_MAX_BYTES);
    }
    const max = Math.min(limit ?? this.feedPageSize, this.feedPageSize);
    const changes: { cursor: number; commit: unknown }[] = [];
    let next = cursor;
    for (let i = cursor; i < this.feed.length && changes.length < max; i++) {
      next = i + 1;
      const entry = this.feed[i];
      if (this.#visible(entry)) {
        changes.push({ cursor: i + 1, commit: entry.json });
      }
    }
    return { changes, cursor: next, more: next < this.feed.length };
  }

  partitionCommits(
    partition: PartitionKey,
    after: number,
    signal: AbortSignal,
    limit?: number,
  ): Promise<PartitionCommitsPage> {
    this.requests.partitionCommits++;
    this.partitionReads.push({ after, limit });
    signal.throwIfAborted();
    if (this.tooLarge?.("partition", limit) === true) {
      return Promise.reject(
        new ServeReplyTooLargeError(
          200,
          "partitions/{p}/commits",
          SERVE_PAGE_MAX_BYTES,
        ),
      );
    }
    if (this.partitionFaults > 0) {
      this.partitionFaults--;
      return Promise.reject(this.#unreachable("maybe"));
    }
    const key = partition.toString();
    if (this.unreadablePartitions.has(key)) {
      return Promise.reject(
        new ServeUpstreamError(404, "not_found", "No such partition"),
      );
    }
    const compacted = this.compactedThrough.get(key) ?? 0;
    if (after + 1 <= compacted) {
      return Promise.reject(
        new ServeCommitsCompactedError(
          compacted,
          `Partition ${key} is compacted through seq ${compacted}`,
        ),
      );
    }
    const max = Math.min(limit ?? FAKE_SERVE_MAX_PAGE, FAKE_SERVE_MAX_PAGE);
    const log = this.#log(partition.toString());
    const commits = log.slice(after, after + max)
      .filter((entry) => this.#visible(entry))
      .map((entry) => entry.json);
    return Promise.resolve({ head: log.length, commits });
  }

  async postCommit(
    partition: PartitionKey,
    envelope: CommitEnvelope,
    chunks: readonly CommitChunk[],
    signal: AbortSignal,
  ): Promise<CommitReply> {
    this.requests.postCommit++;
    signal.throwIfAborted();
    this.posted.push({
      partition: partition.toString(),
      envelope: { ...envelope },
      chunks: chunks.map((chunk) => chunk.sha256),
    });
    await this.beforePost?.();
    const fault = this.postFaults.shift();
    if (fault?.kind === "never") throw this.#unreachable("never");
    if (fault?.kind === "collect") {
      for (const hash of fault.hashes) this.chunks.delete(hash);
    }
    const key = partition.toString();
    const log = this.#log(key);
    const landed = log.find((entry) => entry.txnId === envelope.txnId);
    if (landed !== undefined) return { seq: landed.seq, duplicate: true };
    if (envelope.expectedSeq !== log.length) {
      throw new ServeStaleSeqError(log.length, "stale seq");
    }
    for (const chunk of chunks) this.chunks.set(chunk.sha256, chunk.bytes);
    const json = this.#stamp(key, log.length + 1, envelope);
    const commit = await Commit.fromJSON(json);
    const missing = commit.chunkRefs().filter((hash) => !this.chunks.has(hash));
    if (missing.length > 0) {
      throw new ServeChunksMissingError(missing, "chunks missing");
    }
    this.#push({
      partition: key,
      seq: commit.seq,
      txnId: commit.txnId,
      json,
    });
    if (fault?.kind === "maybe") throw this.#unreachable("maybe");
    return { seq: commit.seq, duplicate: false };
  }

  hasChunks(
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    this.requests.hasChunks++;
    this.hasAsked.push([...hashes]);
    signal.throwIfAborted();
    return Promise.resolve(
      new Set(hashes.filter((hash) => this.chunks.has(hash))),
    );
  }

  putChunk(
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
    partition?: PartitionKey,
  ): Promise<{ sha256: string; size: number }> {
    this.requests.putChunk++;
    signal.throwIfAborted();
    this.uploads.push({ sha256, partition: partition?.toString() });
    this.chunks.set(sha256, bytes);
    return Promise.resolve({ sha256, size: bytes.byteLength });
  }

  getChunk(sha256: string, signal: AbortSignal): Promise<Uint8Array | null> {
    this.requests.getChunk++;
    signal.throwIfAborted();
    return Promise.resolve(this.chunks.get(sha256) ?? null);
  }

  /** The commit serve holds at `seq`, as serve stamped it. */
  commitAt(partition: PartitionKey, seq: number): CommitJSON | undefined {
    return this.#log(partition.toString())[seq - 1]?.json;
  }

  #stamp(
    partition: string,
    seq: number,
    envelope: CommitEnvelope,
  ): CommitJSON {
    return {
      v: 3,
      seq,
      partition,
      namespace: "",
      txnId: envelope.txnId,
      writer: SERVE_WRITER,
      principal: SERVE_PRINCIPAL,
      fence: SERVE_FENCE,
      at: SERVE_AT,
      ops: envelope.ops as CommitJSON["ops"],
    };
  }

  #visible(entry: LogEntry): boolean {
    return entry.json !== undefined && !this.hidden.has(entry.txnId);
  }

  #push(entry: LogEntry): void {
    this.#log(entry.partition).push(entry);
    this.feed.push(entry);
  }

  #log(partition: string): LogEntry[] {
    let log = this.logs.get(partition);
    if (log === undefined) {
      log = [];
      this.logs.set(partition, log);
    }
    return log;
  }

  #unreachable(sent: "never" | "maybe"): ServeUnreachableError {
    return new ServeUnreachableError(
      SERVE_URL,
      sent,
      new Error(sent === "never" ? "tcp connect error" : "connection reset"),
    );
  }
}

/**
 * A commit another caller wrote through serve, as serve stamped it: a
 * fixture commit with serve's writer, principal and fence.
 */
export function serveStamped(
  seq: number,
  ops: Commit["ops"],
  partition: PartitionKey,
  txnId = `other-${seq}`,
): Commit {
  return Commit.create({
    seq,
    partition,
    namespace: "",
    txnId,
    writer: SERVE_WRITER,
    principal: "bob@example.com",
    fence: SERVE_FENCE,
    at: SERVE_AT,
    ops,
  });
}

/** Removes a test's temp dir; Windows may hold sqlite handles briefly. */
export async function removeTempDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    // Best-effort: EBUSY can fire when V8 hasn't GC'd native
    // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}
