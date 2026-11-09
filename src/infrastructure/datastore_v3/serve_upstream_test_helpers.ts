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

import { Commit, type CommitJSON } from "../../domain/datastore_v3/commit.ts";
import type {
  ObservedBaseEntry,
  ObservedBasePage,
} from "../../domain/datastore_v3/observed_base.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import {
  type AnchorVerdict,
  type BatchedCommit,
  type BatchedCommitOutcome,
  type ChangesPage,
  type CommitBatchReply,
  type CommitChunk,
  type CommitEnvelope,
  type CommitReply,
  type FeedAnchor,
  type PartitionCommitsPage,
  SERVE_PAGE_MAX_BYTES,
  type ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import {
  ServeChunksMissingError,
  ServeCommitRejectedError,
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

export const FAKE_SERVE_MAX_PAGE = 1000;

interface LogEntry {
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
  readonly json: CommitJSON | undefined;
}

export interface PostedCommit {
  readonly partition: string;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly chunks: readonly string[];
}

export type PostFault =
  | { readonly kind: "never" }
  | { readonly kind: "maybe" }
  | { readonly kind: "collect"; readonly hashes: readonly string[] };

type Client = Pick<
  ServeDatastoreClient,
  | "baseUrl"
  | "namespace"
  | "changes"
  | "partitionCommits"
  | "compactedBase"
  | "postCommit"
  | "hasChunks"
  | "putChunk"
  | "getChunk"
>;

export class FakeServe implements Client {
  readonly baseUrl = SERVE_URL;
  readonly namespace: string;
  readonly feed: LogEntry[] = [];
  readonly logs = new Map<string, LogEntry[]>();
  readonly hidden = new Set<string>();
  readonly chunks = new Map<string, Uint8Array>();
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
  readonly partitionReads: {
    after: number;
    limit: number | undefined;
    held?: number | undefined;
  }[] = [];
  readonly changesReads: { cursor: number; limit: number | undefined }[] = [];
  tooLarge:
    | ((
      route: "changes" | "partition" | "base",
      limit: number | undefined,
    ) => boolean)
    | undefined;
  readonly postFaults: PostFault[] = [];
  /** answers every commit that carries chunks with this, as a bucket write failing at serve does */
  failsCarried: Error | undefined;
  beforePost: (() => Promise<void>) | undefined;
  leaseLost: ((lease: string | undefined) => boolean) | undefined;
  changesFault: Error | undefined;
  partitionFaults = 0;
  readonly compactedThrough = new Map<string, number>();
  readonly unreadablePartitions = new Set<string>();
  changesGate: Promise<void> | undefined;
  base: { point: number; entries: ObservedBaseEntry[] } | undefined;
  compactionPoint = 0;
  basePageSize = FAKE_SERVE_MAX_PAGE;
  readonly baseReads: {
    after: string | undefined;
    limit: number | undefined;
  }[] = [];
  beforeBasePage: ((page: number) => void) | undefined;

  constructor(namespace = "_default") {
    this.namespace = namespace;
  }

  head(partition: PartitionKey): number {
    return this.#log(partition.toString()).length;
  }

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

  /**
   * answers an anchor asked with a changes read, as a serve that takes them
   * does; off, it ignores the anchor, as an older serve does
   */
  checksAnchors = false;
  readonly anchorsAsked: FeedAnchor[] = [];

  async changes(
    cursor: number,
    signal: AbortSignal,
    limit?: number,
    anchor?: FeedAnchor,
  ): Promise<ChangesPage> {
    this.requests.changes++;
    this.changesReads.push({ cursor, limit });
    const verdict = anchor !== undefined && this.checksAnchors
      ? this.#anchorVerdict(anchor)
      : undefined;
    if (this.changesGate !== undefined) await this.changesGate;
    signal.throwIfAborted();
    if (this.changesFault !== undefined) throw this.changesFault;
    if (cursor < this.compactionPoint) {
      throw new ServeCommitsCompactedError(
        this.compactionPoint,
        `The changes feed is compacted through ${this.compactionPoint}`,
      );
    }
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
    return {
      changes,
      cursor: next,
      more: next < this.feed.length,
      ...(verdict === undefined ? {} : { anchor: verdict }),
    };
  }

  #anchorVerdict(anchor: FeedAnchor): AnchorVerdict {
    this.anchorsAsked.push(anchor);
    if (this.unreadablePartitions.has(anchor.partition)) {
      return { verdict: "unchecked" };
    }
    if ((this.compactedThrough.get(anchor.partition) ?? 0) >= anchor.seq) {
      return { verdict: "unchecked" };
    }
    const log = this.#log(anchor.partition);
    if (log.length < anchor.seq) {
      return { verdict: "behind", serveHead: log.length };
    }
    const entry = log[anchor.seq - 1];
    if (!this.#visible(entry)) return { verdict: "unchecked" };
    return entry.txnId === anchor.txnId &&
        entry.json?.namespace === anchor.namespace
      ? { verdict: "held" }
      : { verdict: "other-commit", serveTxnId: entry.txnId };
  }

  compactedBase(
    after: string | undefined,
    namespace: string,
    signal: AbortSignal,
    limit?: number,
  ): Promise<ObservedBasePage> {
    this.baseReads.push({ after, limit });
    signal.throwIfAborted();
    this.beforeBasePage?.(this.baseReads.length - 1);
    if (this.base === undefined) {
      return Promise.reject(
        new ServeUpstreamError(404, "not_found", "Not found"),
      );
    }
    if (this.tooLarge?.("base", limit) === true) {
      return Promise.reject(
        new ServeReplyTooLargeError(200, "base", SERVE_PAGE_MAX_BYTES),
      );
    }
    const from = after === undefined ? 0 : Number(after);
    const max = Math.min(limit ?? this.basePageSize, this.basePageSize);
    const entries = this.base.entries.slice(from, from + max).filter((entry) =>
      entry.namespace === namespace
    );
    const end = Math.min(from + max, this.base.entries.length);
    return Promise.resolve({
      point: this.base.point,
      entries,
      next: end < this.base.entries.length ? String(end) : undefined,
    });
  }

  partitionCommits(
    partition: PartitionKey,
    after: number,
    signal: AbortSignal,
    limit?: number,
    held?: number,
  ): Promise<PartitionCommitsPage> {
    this.requests.partitionCommits++;
    this.partitionReads.push({
      after,
      limit,
      ...(held !== undefined && held > 0 ? { held } : {}),
    });
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
          compacted,
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

  /** takes POST commits, as a serve with the commit-batch feature does */
  takesBatches = false;
  /** answers each commit with the commit as stamped and its parent */
  stampsReplies = false;
  readonly batches: { partitions: string[]; release?: string }[] = [];
  readonly releasedByBatch: string[] = [];

  takesCommitBatches(): boolean {
    return this.takesBatches;
  }

  async postCommits(
    commits: readonly BatchedCommit[],
    release: string | undefined,
    signal: AbortSignal,
  ): Promise<CommitBatchReply> {
    this.batches.push({
      partitions: commits.map((commit) => commit.partition.toString()),
      ...(release === undefined ? {} : { release }),
    });
    const outcomes: BatchedCommitOutcome[] = [];
    for (const commit of commits) {
      try {
        outcomes.push({
          kind: "landed",
          reply: await this.postCommit(
            commit.partition,
            commit.envelope,
            commit.chunks,
            signal,
          ),
        });
      } catch (error) {
        if (error instanceof ServeUnreachableError) throw error;
        outcomes.push({ kind: "refused", error: error as Error });
        break;
      }
    }
    while (outcomes.length < commits.length) {
      outcomes.push({ kind: "not-tried" });
    }
    const released = release !== undefined &&
      outcomes.every((outcome) => outcome.kind === "landed");
    if (released) this.releasedByBatch.push(release);
    return { outcomes, released };
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
    if (this.leaseLost?.(envelope.lease) === true) {
      throw new ServeCommitRejectedError(
        "lease-lost",
        "commit_lease-lost",
        "This commit's model lease is not held: take the lock again and retry",
      );
    }
    if (this.failsCarried !== undefined && chunks.length > 0) {
      throw this.failsCarried;
    }
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
    const parent = log[commit.seq - 2];
    return {
      seq: commit.seq,
      duplicate: false,
      ...(this.stampsReplies
        ? {
          commit: json,
          ...(parent === undefined ? {} : { parentTxnId: parent.txnId }),
        }
        : {}),
    };
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

export async function removeTempDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    // Best-effort: EBUSY can fire when V8 hasn't GC'd native
    // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}
