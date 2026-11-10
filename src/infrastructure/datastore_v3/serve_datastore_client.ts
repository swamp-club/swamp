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
 * a 429 with Retry-After is retried a bounded number of times; other refusals
 * are thrown as mapped by serveErrorFromReply, and no reply is
 * ServeUnreachableError, saying whether the request may have reached serve
 */

import type {
  ServeInitiatorMode,
  ServeUpstreamTarget,
} from "../../domain/datastore_v3/serve_upstream.ts";
import { normalizeServerUrl } from "../../domain/auth/server_url.ts";
import { CHUNK_BYTES } from "../../domain/datastore_v3/chunk_store.ts";
import { MAX_COMMIT_OPS } from "../../domain/datastore_v3/commit.ts";
import { MAX_FIELD_LENGTH as MAX_INTENT_FIELD_LENGTH } from "../../domain/datastore_v3/intent.ts";
import type { DataNameMarks } from "../../domain/datastore_v3/commit_store.ts";
import {
  dataNameMarksFromJSON,
  type ObservedBaseEntry,
  observedBaseEntryFromJSON,
  type ObservedBasePage,
} from "../../domain/datastore_v3/observed_base.ts";
import { MAX_INLINE_BYTES, type Op } from "../../domain/datastore_v3/op.ts";
import { chunksToWire } from "../../domain/datastore_v3/quarantine.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { MAX_RECORD_KEY_LENGTH } from "../../domain/datastore_v3/record_key.ts";
import {
  type ChunkDeclaration,
  ChunkHashMismatchError,
  encodeCommitBody,
} from "./chunk_ingest.ts";
import { type Span, withSpan } from "../tracing/tracer.ts";
import { injectTraceContext } from "../tracing/propagation.ts";
import { isNetworkFailure } from "./network_failure.ts";
import { SERVE_REQUEST_SYNC_DEADLINE_MS } from "./serve_request_deadlines.ts";
import { recordServeClock } from "./serve_offline.ts";
import {
  serveErrorFromReply,
  ServeLeaseLapsedLatch,
  ServeLeaseLapsedRequestError,
  ServeReplyTooLargeError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";

export const MAX_HAS_HASHES = 1024;

export const DEFAULT_SERVE_TIMEOUT_MS = 30_000;

/**
 * how long serve may take to start its reply, past any wait the request asks
 * of it and its upload; a node that accepts connections but never answers (a
 * stopped process) fails within it instead of the whole request timeout
 */
export const SERVE_RESPONSE_BASE_MS = 10_000;

/**
 * a commit's reply waits for serve to confirm it replicated, which may take up
 * to its own request deadline; past it, and a margin, serve is not answering
 */
export const SERVE_COMMIT_RESPONSE_BASE_MS = SERVE_REQUEST_SYNC_DEADLINE_MS +
  5_000;

/** the slowest upload a request's deadline allows for, past its flat timeout */
export const MIN_SERVE_UPLOAD_BYTES_PER_SECOND = 256 * 1024;

function bodyBytesOf(body: RequestSpec["body"]): number {
  if (body === undefined) return 0;
  return typeof body === "string" ? body.length : body.byteLength;
}

export function serveRequestDeadlineMs(
  timeoutMs: number,
  bodyBytes: number,
): number {
  return timeoutMs +
    Math.ceil(bodyBytes * 1000 / MIN_SERVE_UPLOAD_BYTES_PER_SECOND);
}

export function serveResponseDeadlineMs(
  responseBaseMs: number,
  timeoutMs: number,
  bodyBytes: number,
  serverWaitMs: number,
): number {
  return Math.min(
    serveRequestDeadlineMs(timeoutMs, bodyBytes),
    serveRequestDeadlineMs(Math.min(responseBaseMs, timeoutMs), bodyBytes) +
      serverWaitMs,
  );
}

/**
 * once a write found serve unreachable, the rest of the command fails at once
 * instead of waiting out a request timeout per call; requests in flight end too
 */
const unreachableLatches = new Map<string, AbortController>();

function unreachableLatchOf(baseUrl: string): AbortSignal {
  let latch = unreachableLatches.get(baseUrl);
  if (latch === undefined) {
    latch = new AbortController();
    unreachableLatches.set(baseUrl, latch);
  }
  return latch.signal;
}

/** set by a write's failure or an unrenewed lease; a read never sets it */
export function latchServeUnreachable(baseUrl: string, cause: unknown): void {
  unreachableLatchOf(baseUrl);
  const latch = unreachableLatches.get(baseUrl)!;
  if (!latch.signal.aborted) latch.abort(cause);
}

/** the command's end: the next command asks serve afresh */
export function clearServeUnreachableLatches(): void {
  unreachableLatches.clear();
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/** how long a cancel of a lock request that got no reply may take */
export const LOCK_REQUEST_CANCEL_DEADLINE_MS = 5_000;

export const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

/**
 * the most bytes of an error reply's body read; past it the refusal is mapped
 * from its status alone
 */
export const SERVE_ERROR_BODY_MAX_BYTES = 64 * 1024;

export const SERVE_REPLY_MAX_BYTES = 1024 * 1024;

export const SERVE_PAGE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * a fenced behavior lease carries its floor, every data name's marks, so it
 * gets the page cap the compacted base reads the same names under
 */
export const SERVE_LEASE_REPLY_MAX_BYTES = SERVE_PAGE_MAX_BYTES;

const UTF8_BYTES_PER_UNIT = 3;

const MAX_INTENT_STRINGS = 4;

const PUT_OP_SYNTAX_ALLOWANCE = 1024;

export const MAX_PUT_OP_REPLY_BYTES = Math.ceil(MAX_INLINE_BYTES / 3) * 4 +
  MAX_RECORD_KEY_LENGTH * UTF8_BYTES_PER_UNIT +
  MAX_INTENT_STRINGS * MAX_INTENT_FIELD_LENGTH * UTF8_BYTES_PER_UNIT +
  PUT_OP_SYNTAX_ALLOWANCE;

const COMMIT_REPLY_HEADER_ALLOWANCE = 32 * 1024;

/**
 * the largest commit serve writes: its own runs split a partition only at
 * MAX_COMMIT_OPS, so it exceeds any a client can post
 */
export const MAX_WRITTEN_COMMIT_REPLY_BYTES =
  MAX_COMMIT_OPS * MAX_PUT_OP_REPLY_BYTES + COMMIT_REPLY_HEADER_ALLOWANCE;

export const COMMIT_CONTENT_TYPE = "application/vnd.swamp.commit+v1";

export const SERVE_DATASTORE_LOG_HEADER = "x-swamp-datastore-log";

export const SERVE_DATASTORE_ACCESS_HEADER = "x-swamp-datastore-access";

/**
 * names what this client's copy understands; serve leaves lease ops out of
 * commits for a client that does not name `lease-ops`, which an older swamp
 * would refuse by judging their fence against the writer fence
 */
export const SERVE_DATASTORE_FEATURES_HEADER = "x-swamp-datastore-features";

/** what serve last said of run initiators, per serve and token, process-wide */
const heardInitiators = new Map<string, ServeInitiatorMode>();

/** the features serve last named, per serve and token, process-wide */
const heardFeatures = new Map<string, readonly string[]>();

export function resetHeardServeRepliesForTesting(): void {
  heardInitiators.clear();
  heardFeatures.clear();
}

export const LEASE_OPS_FEATURE = "lease-ops";

/** without it in serve's replies, a member commits each start as the whole record */
export const STEP_STARTS_FEATURE = "step-starts";

/** serve checks removals a command will commit, before it commits any */
export const AUTHORIZE_ONLY_FEATURE = "authorize-only";

/** serve names a lease's holder and answers at once when waiting cannot help */
export const LEASE_HOLDER_FEATURE = "lease-holder";

/**
 * serve takes several partitions' commits in one `POST commits`, confirms them
 * once, and can end the command's lease with them
 */
export const COMMIT_BATCH_FEATURE = "commit-batch";

/** the most commits serve takes in one `POST commits` */
export const MAX_BATCH_COMMITS = 16;

/** serve refuses a new run record that does not name the principal it stamps */
export const RUN_INITIATOR_FEATURE = "run-initiator";

/** the principal serve stamps on the caller's commits, percent-encoded */
export const SERVE_DATASTORE_PRINCIPAL_HEADER = "x-swamp-datastore-principal";

/** the check advertised with no principal is no check this client can meet */
function initiatorModeOf(
  features: readonly string[],
  encodedPrincipal: string | null,
): ServeInitiatorMode {
  if (!features.includes(RUN_INITIATOR_FEATURE) || encodedPrincipal === null) {
    return { kind: "not-checked" };
  }
  try {
    return { kind: "checked", principal: decodeURIComponent(encodedPrincipal) };
  } catch {
    return { kind: "not-checked" };
  }
}

export function serveRequestTimeoutMs(): number {
  const env = Deno.env.get("SWAMP_SERVE_TIMEOUT_MS");
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SERVE_TIMEOUT_MS;
}

export interface ServeDatastoreClientOptions {
  readonly baseUrl: string;
  readonly namespace?: string;
  readonly token?: string;
  /**
   * Makes the HTTP client requests go through (a private CA, say). Called
   * once, on the first request, never at construction.
   */
  readonly httpClient?: () => Deno.HttpClient;
  readonly timeoutMs?: number;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  readonly timeoutSignal?: (ms: number) => AbortSignal;
  readonly maxAttempts?: number;
  readonly maxRetryDelayMs?: number;
  readonly responseBaseMs?: number;
  readonly commitResponseBaseMs?: number;
}

export interface CommitChunk {
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface CommitEnvelope {
  readonly expectedSeq: number;
  readonly txnId: string;
  readonly fence?: number;
  /**
   * the fenced model lease the commit is made under: its id only; serve stamps
   * the lease op from its own record of the lease
   */
  readonly lease?: string;
  readonly ops: readonly unknown[];
}

export interface CommitReply {
  readonly seq: number;
  readonly duplicate: boolean;
  readonly warning?: string;
  /** the commit as serve stamped it; absent from an older serve */
  readonly commit?: unknown;
  /** the txnId at the seq before it, when serve could name it */
  readonly parentTxnId?: string;
}

export interface BatchedCommit {
  readonly partition: PartitionKey;
  readonly envelope: CommitEnvelope;
  readonly chunks: readonly CommitChunk[];
}

/** what serve did with one commit of a batch */
export type BatchedCommitOutcome =
  | { readonly kind: "landed"; readonly reply: CommitReply }
  /** the error the single route would have answered it with */
  | { readonly kind: "refused"; readonly error: Error }
  /** an earlier commit did not land, so serve did not try this one */
  | { readonly kind: "not-tried" };

export interface CommitBatchReply {
  readonly outcomes: readonly BatchedCommitOutcome[];
  /** serve ended the lease named to release with these commits */
  readonly released: boolean;
}

export interface PartitionCommitsPage {
  readonly head: number;
  readonly commits: readonly unknown[];
}

export interface ChangeEntry {
  readonly cursor: number;
  readonly commit: unknown;
}

export interface ChangesPage {
  readonly changes: readonly ChangeEntry[];
  readonly cursor: number;
  readonly more: boolean;
  /** serve's check of the anchor asked with the page; absent from an older serve */
  readonly anchor?: AnchorVerdict;
}

/** the commit a copy's feed cursor follows */
export interface FeedAnchor {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
}

export type AnchorVerdict =
  | { readonly verdict: "held" | "unchecked" }
  | { readonly verdict: "behind"; readonly serveHead: number }
  | { readonly verdict: "other-commit"; readonly serveTxnId: string };

/** where a copy's feed stands, which serve answers with what it lacks */
export interface CatchUpRequest {
  readonly cursor: number;
  readonly anchor?: FeedAnchor;
}

/** a catch-up serve answered along with another request */
export interface DeliveredCatchUp {
  readonly requested: CatchUpRequest;
  /** the first page; absent when serve refused it */
  readonly page?: ChangesPage;
  /** what a GET changes would have been refused with (a compacted log) */
  readonly refused?: Error;
}

export interface ChunkRange {
  readonly start: number;
  readonly end?: number;
}

export interface LockLease {
  readonly leaseId: string;
  readonly lockKey: string;
  readonly ttlMs: number;
  readonly expiresAt: string;
  /**
   * a fenced lease's fence; absent when serve does not fence leases (an older
   * serve), so the lease is unfenced
   */
  readonly fence?: number;
  /**
   * a fenced model lease's data-version floor when taken: each data name's
   * marks, which the holder allocates versions above
   */
  readonly floor?: readonly DataNameMarks[];
  readonly holdMs?: number;
}

export type RemovalVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly message: string };

/** who holds a lease, as a serve that names lease-holder says */
export interface ServeLeaseHolder {
  readonly principal: string;
  readonly explicit: boolean;
  readonly expiresAt: string;
}

export interface ServeLeaseEntry {
  readonly lockKey: string;
  readonly heldBy: "caller" | "other";
  readonly expiresAt: string;
  readonly holder?: ServeLeaseHolder;
}

export interface ServeLeaseListing {
  readonly leases: readonly ServeLeaseEntry[];
  readonly truncated: boolean;
}

export type LockAcquireReply =
  | {
    readonly acquired: true;
    readonly lease: LockLease;
    /** absent from an older serve, or when serve could not read it */
    readonly catchUp?: DeliveredCatchUp;
  }
  | {
    readonly acquired: false;
    readonly heldBy: string;
    readonly message: string;
    readonly holder?: ServeLeaseHolder;
  };

interface RequestSpec {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array<ArrayBuffer> | string;
  /** how long the request asks serve to wait before it answers */
  readonly serverWaitMs?: number;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * answered without serve confirming a replicated write: a read, a chunk check
 * or a lock call; anything else may wait for that confirmation
 */
export function answersWithoutConfirm(method: string, path: string): boolean {
  return method === "GET" || path === "chunks/has" || path === "locks" ||
    path.startsWith("locks/");
}

/** safe to send again on a fresh connection: serve changes nothing for it */
function isReadSpec(spec: RequestSpec): boolean {
  return spec.method === "GET" || spec.path === "chunks/has";
}

export class ServeDatastoreClient {
  readonly baseUrl: string;
  readonly namespace: string;
  readonly #token: string | undefined;
  readonly #makeHttpClient: (() => Deno.HttpClient) | undefined;
  #httpClient: Deno.HttpClient | undefined;
  // a client whose connection timed out takes no new request; requests still
  // in flight on it finish there, and close() ends it
  readonly #retiredClients: Deno.HttpClient[] = [];
  #ownConnectionAfterTimeout = false;
  readonly #timeoutMs: number;
  readonly #responseBaseMs: number;
  readonly #commitResponseBaseMs: number;
  readonly #extraHeaders: Readonly<Record<string, string>>;
  readonly #fetch: typeof fetch;
  readonly #timeoutSignal: (ms: number) => AbortSignal;
  readonly #maxAttempts: number;
  readonly #maxRetryDelayMs: number;
  #logCheck: ((logId: string | undefined) => void) | undefined;
  #accessCheck: ((fingerprint: string) => void) | undefined;
  #takesStepStarts = false;
  #takesCommitBatches = false;
  #heardReply = false;
  #initiatorMode: ServeInitiatorMode | undefined;

  constructor(options: ServeDatastoreClientOptions) {
    this.baseUrl = normalizeServerUrl(options.baseUrl);
    this.namespace = options.namespace === undefined ||
        options.namespace === ""
      ? "_default"
      : options.namespace;
    this.#token = options.token === "" ? undefined : options.token;
    this.#makeHttpClient = options.httpClient;
    this.#timeoutMs = options.timeoutMs ?? serveRequestTimeoutMs();
    this.#extraHeaders = options.extraHeaders ?? {};
    this.#fetch = options.fetch ??
      ((input, init) => globalThis.fetch(input, init));
    this.#timeoutSignal = options.timeoutSignal ??
      ((ms) => AbortSignal.timeout(ms));
    this.#maxAttempts = Math.max(
      1,
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    );
    this.#maxRetryDelayMs = options.maxRetryDelayMs ??
      DEFAULT_MAX_RETRY_DELAY_MS;
    this.#responseBaseMs = options.responseBaseMs ?? SERVE_RESPONSE_BASE_MS;
    this.#commitResponseBaseMs = options.commitResponseBaseMs ??
      SERVE_COMMIT_RESPONSE_BASE_MS;
  }

  close(): void {
    this.#httpClient?.close();
    this.#httpClient = undefined;
    for (const client of this.#retiredClients.splice(0)) client.close();
  }

  async hasChunks(
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    const unique = [...new Set(hashes)];
    const held = new Set<string>();
    for (let i = 0; i < unique.length; i += MAX_HAS_HASHES) {
      const batch = unique.slice(i, i + MAX_HAS_HASHES);
      const body = await this.#json({
        method: "POST",
        path: "chunks/has",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hashes: batch }),
      }, signal);
      const answered = body.held;
      if (!Array.isArray(answered)) throw invalidReply("chunks/has", "held");
      for (const hash of answered) {
        if (typeof hash === "string") held.add(hash);
      }
    }
    return held;
  }

  /**
   * Uploads one chunk. `partition` is the partition a commit will name it
   * from: without one, serve asks for admin.
   */
  async putChunk(
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
    partition?: PartitionKey,
  ): Promise<ChunkDeclaration> {
    const body = await this.#json({
      method: "PUT",
      path: `chunks/${encodeURIComponent(sha256)}`,
      query: partition === undefined
        ? undefined
        : { partition: partition.toString() },
      // fetch sends a Content-Length for a byte body, which serve requires.
      headers: { "content-type": "application/octet-stream" },
      body: ownBuffer(bytes),
    }, signal);
    if (typeof body.sha256 !== "string" || typeof body.size !== "number") {
      throw invalidReply("chunks/{sha256}", "sha256 and size");
    }
    return { sha256: body.sha256, size: body.size };
  }

  async getChunk(
    sha256: string,
    signal: AbortSignal,
    range?: ChunkRange,
  ): Promise<Uint8Array | null> {
    const headers: Record<string, string> = {};
    if (range !== undefined) {
      headers.range = `bytes=${range.start}-${range.end ?? ""}`;
    }
    return await this.#exchange(
      {
        method: "GET",
        path: `chunks/${encodeURIComponent(sha256)}`,
        headers,
      },
      signal,
      async (response) => {
        if (response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        if (response.status !== 200 && response.status !== 206) {
          throw await this.#refusal(response, "chunks/{sha256}");
        }
        const bytes = await readBounded(
          response,
          "chunks/{sha256}",
          response.status === 206 && range !== undefined
            ? rangeBytes(range)
            : CHUNK_BYTES,
        );
        if (response.status === 200) {
          const actual = await sha256Hex(bytes);
          if (actual !== sha256) {
            throw new ChunkHashMismatchError(sha256, actual);
          }
        }
        return bytes;
      },
    );
  }

  async postCommit(
    partition: PartitionKey,
    envelope: CommitEnvelope,
    chunks: readonly CommitChunk[],
    signal: AbortSignal,
  ): Promise<CommitReply> {
    const body = await this.#json(
      {
        method: "POST",
        path: `${partitionPath(partition)}/commits`,
        headers: { "content-type": COMMIT_CONTENT_TYPE },
        body: frameCommit(envelope, chunks),
      },
      signal,
      MAX_WRITTEN_COMMIT_REPLY_BYTES,
    );
    return commitReplyOf(body, "commits");
  }

  /**
   * commits to several partitions in one request; serve applies them in order
   * and stops at the first that does not land. Only for a serve that takes
   * batches (takesCommitBatches)
   */
  async postCommits(
    commits: readonly BatchedCommit[],
    release: string | undefined,
    signal: AbortSignal,
  ): Promise<CommitBatchReply> {
    const header = new TextEncoder().encode(JSON.stringify({
      items: commits.map((commit) => ({
        partition: commit.partition.toString(),
      })),
      ...(release === undefined ? {} : { release }),
    }));
    const frames = commits.map((commit) =>
      frameCommit(commit.envelope, commit.chunks)
    );
    const framed = new Uint8Array(
      4 + header.byteLength +
        frames.reduce((total, frame) => total + frame.byteLength, 0),
    );
    new DataView(framed.buffer).setUint32(0, header.byteLength, false);
    framed.set(header, 4);
    let offset = 4 + header.byteLength;
    for (const frame of frames) {
      framed.set(frame, offset);
      offset += frame.byteLength;
    }
    const body = await this.#json(
      {
        method: "POST",
        path: "commits",
        headers: { "content-type": COMMIT_CONTENT_TYPE },
        body: framed,
      },
      signal,
      // each result may carry its whole commit, as a single reply does
      commits.length * MAX_WRITTEN_COMMIT_REPLY_BYTES,
    );
    if (
      !Array.isArray(body.results) || body.results.length > commits.length
    ) {
      throw invalidReply("commits", "one result per commit tried");
    }
    const outcomes: BatchedCommitOutcome[] = [];
    for (const result of body.results as unknown[]) {
      const item = result as {
        status?: unknown;
        body?: unknown;
        retryAfter?: unknown;
      } | null;
      if (item === null || typeof item.status !== "number") {
        throw invalidReply("commits", "a status per result");
      }
      outcomes.push(
        item.status === 200
          ? {
            kind: "landed",
            reply: commitReplyOf(
              item.body as Record<string, unknown>,
              "commits",
            ),
          }
          : {
            kind: "refused",
            error: serveErrorFromReply(
              item.status,
              item.body,
              this.baseUrl,
              retryAfterSeconds(
                typeof item.retryAfter === "string" ? item.retryAfter : null,
              ),
            ),
          },
      );
    }
    while (outcomes.length < commits.length) {
      outcomes.push({ kind: "not-tried" });
    }
    return { outcomes, released: body.released === true };
  }

  /**
   * with `held`, the seq the copy holds, a follower behind it refuses as behind
   * instead of answering with a head that reads as a rewind; a serve that does
   * not read it answers as before
   */
  async partitionCommits(
    partition: PartitionKey,
    after: number,
    signal: AbortSignal,
    limit?: number,
    held?: number,
  ): Promise<PartitionCommitsPage> {
    const body = await this.#json(
      {
        method: "GET",
        path: `${partitionPath(partition)}/commits`,
        query: {
          after: String(after),
          ...(limit === undefined ? {} : { limit: String(limit) }),
          ...(held === undefined || held <= 0 ? {} : { held: String(held) }),
        },
      },
      signal,
      pageMaxBytes(limit),
    );
    if (!isSeq(body.head) || !Array.isArray(body.commits)) {
      throw invalidReply("partitions/{p}/commits", "head and commits");
    }
    return { head: body.head, commits: body.commits };
  }

  /** with `anchor`, serve checks it too; an older serve ignores it */
  async changes(
    cursor: number,
    signal: AbortSignal,
    limit?: number,
    anchor?: FeedAnchor,
  ): Promise<ChangesPage> {
    const body = await this.#json(
      {
        method: "GET",
        path: "changes",
        query: {
          cursor: String(cursor),
          ...(limit === undefined ? {} : { limit: String(limit) }),
          ...(anchor === undefined ? {} : {
            anchorNamespace: anchor.namespace,
            anchorPartition: anchor.partition,
            anchorSeq: String(anchor.seq),
            anchorTxnId: anchor.txnId,
          }),
        },
      },
      signal,
      pageMaxBytes(limit),
    );
    return changesPageOf(body, "changes");
  }

  /**
   * the reply is read under the page byte limit and every entry is checked: one
   * of another shape or outside `namespace` refuses the whole page
   */
  async compactedBase(
    after: string | undefined,
    namespace: string,
    signal: AbortSignal,
    limit?: number,
  ): Promise<ObservedBasePage> {
    const body = await this.#json(
      {
        method: "GET",
        path: "base",
        query: {
          ...(after === undefined ? {} : { after }),
          ...(limit === undefined ? {} : { limit: String(limit) }),
        },
      },
      signal,
      SERVE_PAGE_MAX_BYTES,
    );
    if (
      !isSeq(body.point) || !Array.isArray(body.entries) ||
      (body.next !== undefined &&
        (typeof body.next !== "string" || body.next.length === 0))
    ) {
      throw invalidReply("base", "point, entries and next");
    }
    let entries: ObservedBaseEntry[];
    try {
      entries = body.entries.map((entry) =>
        observedBaseEntryFromJSON(entry, namespace)
      );
    } catch (error) {
      throw new ServeUpstreamError(
        200,
        "invalid_response",
        `Serve's reply to base holds an entry this copy refuses: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      point: body.point,
      entries,
      next: body.next as string | undefined,
    };
  }

  /**
   * a lock still held after serve waited `waitMs` is `acquired: false`, not an
   * error
   */
  async acquireLock(
    lockKey: string,
    ttlMs: number,
    waitMs: number,
    signal: AbortSignal,
    options: {
      readonly holdMs?: number;
      readonly budgetMs?: number;
      readonly catchUp?: CatchUpRequest;
    } = {},
  ): Promise<LockAcquireReply> {
    // an older serve ignores a field it does not know; a command's lock
    // client has often read no reply yet, so it cannot wait to be told
    const budget = {
      ...(options.budgetMs !== undefined
        ? { budgetMs: Math.max(0, Math.floor(options.budgetMs)) }
        : {}),
      ...(options.catchUp !== undefined ? { catchUp: options.catchUp } : {}),
      requestId: crypto.randomUUID(),
    };
    try {
      return await this.#acquireLockAs(lockKey, ttlMs, waitMs, signal, {
        ...options,
        budget,
      });
    } catch (error) {
      if (error instanceof ServeUnreachableError && error.sent === "maybe") {
        await this.#cancelLockRequest(budget.requestId);
      }
      throw error;
    }
  }

  /**
   * best effort: a request serve may still be holding, or may have granted,
   * is cancelled so its lease never blocks the lock; serve forgets nothing it
   * never saw, and an older serve answers 404
   */
  async #cancelLockRequest(requestId: string): Promise<void> {
    try {
      await this.#exchange(
        {
          method: "DELETE",
          path: `locks/requests/${encodeURIComponent(requestId)}`,
        },
        AbortSignal.timeout(LOCK_REQUEST_CANCEL_DEADLINE_MS),
        async (response) => {
          await response.body?.cancel();
        },
      );
    } catch {
      // the lease, if any, ends with its TTL
    }
  }

  async #acquireLockAs(
    lockKey: string,
    ttlMs: number,
    waitMs: number,
    signal: AbortSignal,
    options: {
      readonly holdMs?: number;
      readonly catchUp?: CatchUpRequest;
      readonly budget: Readonly<Record<string, unknown>>;
    },
  ): Promise<LockAcquireReply> {
    const budget = options.budget;
    return await this.#exchange(
      {
        method: "POST",
        path: "locks",
        headers: { "content-type": "application/json" },
        serverWaitMs: waitMs,
        // an older serve ignores `fenced` and grants an unfenced lease; an
        // explicit lease is held for `holdMs` between renewals
        body: JSON.stringify(
          options.holdMs === undefined
            ? { lockKey, ttlMs, waitMs, fenced: true, ...budget }
            : {
              lockKey,
              waitMs,
              fenced: true,
              holdMs: options.holdMs,
              ...budget,
            },
        ),
      },
      signal,
      async (response) => {
        if (response.status === 409) {
          const body = await readBoundedJson(
            response,
            "locks",
            SERVE_ERROR_BODY_MAX_BYTES,
          ).catch(() => undefined) as Record<string, unknown> | undefined;
          if (body?.code === "lock_held") {
            const holder = leaseHolderOf(body.holder);
            return {
              acquired: false,
              heldBy: typeof body.heldBy === "string" ? body.heldBy : "other",
              message: typeof body.message === "string"
                ? body.message
                : `${lockKey} is held`,
              ...(holder === undefined ? {} : { holder }),
            };
          }
          throw serveErrorFromReply(409, body, this.baseUrl);
        }
        if (!response.ok) throw await this.#refusal(response, "locks");
        const body = await readBoundedJson(
          response,
          "locks",
          SERVE_LEASE_REPLY_MAX_BYTES,
        );
        const catchUp = options.catchUp === undefined
          ? undefined
          : this.#deliveredCatchUp(
            (body as { catchUp?: unknown } | null)?.catchUp,
          );
        return {
          acquired: true,
          lease: leaseOf(body),
          ...(catchUp === undefined ? {} : { catchUp }),
        };
      },
    );
  }

  async renewLock(
    leaseId: string,
    ttlMs: number,
    signal: AbortSignal,
    options: { readonly holdMs?: number } = {},
  ): Promise<LockLease | undefined> {
    return await this.#exchange(
      {
        method: "PUT",
        path: `locks/${encodeURIComponent(leaseId)}`,
        headers: { "content-type": "application/json" },
        // `holdMs` makes the lease explicit, or changes its hold
        body: JSON.stringify(
          options.holdMs === undefined
            ? { ttlMs }
            : { ttlMs, holdMs: options.holdMs },
        ),
      },
      signal,
      async (response) => {
        if (response.status === 404) {
          await response.body?.cancel();
          return undefined;
        }
        if (!response.ok) {
          throw await this.#refusal(response, "locks/{leaseId}");
        }
        return leaseOf(
          await readBoundedJson(
            response,
            "locks/{leaseId}",
            SERVE_REPLY_MAX_BYTES,
          ),
        );
      },
    );
  }

  async releaseLock(leaseId: string, signal: AbortSignal): Promise<boolean> {
    return await this.#exchange(
      { method: "DELETE", path: `locks/${encodeURIComponent(leaseId)}` },
      signal,
      async (response) => {
        if (response.status === 404) {
          await response.body?.cancel();
          return false;
        }
        if (!response.ok) {
          throw await this.#refusal(response, "locks/{leaseId}");
        }
        await response.body?.cancel();
        return true;
      },
    );
  }

  /** undefined from a serve too old to check removals ahead */
  async authorizeRemovals(
    commits: readonly {
      readonly partition: PartitionKey;
      readonly ops: readonly Op[];
    }[],
    signal: AbortSignal,
  ): Promise<readonly RemovalVerdict[] | undefined> {
    return await this.#exchange(
      {
        method: "POST",
        path: "authorize",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commits: commits.map(({ partition, ops }) => ({
            partition: partition.toString(),
            ops: ops.map((op) => op.toJSON()),
          })),
        }),
      },
      signal,
      async (response) => {
        // an older serve has no such route
        if (response.status === 404 || response.status === 405) {
          await response.body?.cancel();
          return undefined;
        }
        if (!response.ok) throw await this.#refusal(response, "authorize");
        const reply = await readBoundedJson(
          response,
          "authorize",
          SERVE_REPLY_MAX_BYTES,
        );
        const verdicts = (reply as { verdicts?: unknown }).verdicts;
        if (!Array.isArray(verdicts) || verdicts.length !== commits.length) {
          throw invalidReply("authorize", "a verdict per commit");
        }
        return verdicts.map((raw): RemovalVerdict => {
          const fields = typeof raw === "object" && raw !== null
            ? raw as Record<string, unknown>
            : {};
          return fields.ok === true ? { ok: true } : {
            ok: false,
            reason: typeof fields.reason === "string" ? fields.reason : "",
            message: typeof fields.message === "string"
              ? fields.message
              : "refused",
          };
        });
      },
    );
  }

  /**
   * ends the lease on `lockKey` whoever holds it; admin only. An older serve
   * has no such route and answers 405, thrown as ServeUpstreamError like any
   * non-success
   */
  async forceReleaseLock(
    lockKey: string,
    signal: AbortSignal,
  ): Promise<{ readonly released: boolean; readonly heldBy?: string }> {
    return await this.#exchange(
      {
        method: "DELETE",
        path: "locks",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockKey }),
      },
      signal,
      async (response) => {
        if (!response.ok) throw await this.#refusal(response, "locks");
        const reply = await readBoundedJson(
          response,
          "locks",
          SERVE_REPLY_MAX_BYTES,
        );
        const fields = typeof reply === "object" && reply !== null
          ? reply as Record<string, unknown>
          : {};
        return {
          released: fields.released === true,
          ...(typeof fields.heldBy === "string"
            ? { heldBy: fields.heldBy }
            : {}),
        };
      },
    );
  }

  async depositQuarantine(
    deposit: {
      readonly commit: unknown;
      readonly base: { readonly seq: number; readonly txnId?: string };
      readonly chunks: readonly CommitChunk[];
    },
    signal: AbortSignal,
  ): Promise<{ readonly duplicate: boolean }> {
    const body = await this.#json({
      method: "POST",
      path: "quarantine",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commit: deposit.commit,
        base: deposit.base,
        chunks: chunksToWire(deposit.chunks),
      }),
    }, signal);
    return { duplicate: body.duplicate === true };
  }

  async acceptQuarantine(
    txnId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return await this.#json({
      method: "POST",
      path: `quarantine/${encodeURIComponent(txnId)}/accept`,
    }, signal);
  }

  async quarantineState(
    txnId: string,
    signal: AbortSignal,
  ): Promise<"held" | "accepted" | "discarded" | undefined> {
    return await this.#exchange(
      {
        method: "GET",
        path: `quarantine/${encodeURIComponent(txnId)}`,
      },
      signal,
      async (response) => {
        if (response.status === 404 || response.status === 405) {
          await response.body?.cancel();
          return undefined;
        }
        if (!response.ok) throw await this.#refusal(response, "quarantine");
        const reply = await readBoundedJson(
          response,
          "quarantine",
          SERVE_REPLY_MAX_BYTES,
        );
        const state = typeof reply === "object" && reply !== null
          ? (reply as Record<string, unknown>).state
          : undefined;
        return state === "held" || state === "accepted" ||
            state === "discarded"
          ? state
          : undefined;
      },
    );
  }

  async discardQuarantine(
    txnId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return await this.#json({
      method: "POST",
      path: `quarantine/${encodeURIComponent(txnId)}/discard`,
    }, signal);
  }

  async listLocks(
    prefix: string,
    signal: AbortSignal,
  ): Promise<ServeLeaseListing | undefined> {
    return await this.#exchange(
      {
        method: "GET",
        path: "locks",
        ...(prefix === "" ? {} : { query: { prefix } }),
      },
      signal,
      async (response) => {
        if (response.status === 405) {
          await response.body?.cancel();
          return undefined;
        }
        if (!response.ok) throw await this.#refusal(response, "locks");
        return leaseListingOf(
          await readBoundedJson(response, "locks", SERVE_REPLY_MAX_BYTES),
        );
      },
    );
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * every reply is checked before it is read, with the log id it names or
   * undefined; a refusal naming none is not checked, and a throw refuses the
   * reply
   */
  checkLog(check: (logId: string | undefined) => void): void {
    this.#logCheck = check;
  }

  /**
   * replies naming the caller's read access are reported to `check` once the
   * log check passed; a reply naming none is not reported. It never refuses a
   * reply, since serve filters under current access
   */
  checkAccess(check: (fingerprint: string) => void): void {
    this.#accessCheck = check;
  }

  async #json(
    spec: RequestSpec,
    signal: AbortSignal,
    maxBytes = SERVE_REPLY_MAX_BYTES,
  ): Promise<Record<string, unknown>> {
    return await this.#exchange(spec, signal, async (response) => {
      if (!response.ok) throw await this.#refusal(response, spec.path);
      const body: unknown = await readBoundedJson(
        response,
        spec.path,
        maxBytes,
      );
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw invalidReply(spec.path, "a JSON object");
      }
      return body as Record<string, unknown>;
    });
  }

  /**
   * undefined until a reply from serve itself has been read, by this client or
   * another of this process's for the same serve and token (a lock's own)
   */
  initiatorMode(): ServeInitiatorMode | undefined {
    return this.#initiatorMode ?? heardInitiators.get(this.#heardKey());
  }

  #heardKey(): string {
    return `${this.baseUrl}\0${this.#token ?? ""}`;
  }

  takesStepStarts(): boolean {
    return this.#takesStepStarts ||
      this.#heardFeature(STEP_STARTS_FEATURE);
  }

  /** a client that read no reply yet goes by what another of the process's heard */
  #heardFeature(feature: string): boolean {
    return !this.#heardReply &&
      (heardFeatures.get(this.#heardKey())?.includes(feature) ?? false);
  }

  /** a reply's catch-up that does not parse is read again, never trusted */
  #deliveredCatchUp(value: unknown): DeliveredCatchUp | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const fields = value as Record<string, unknown>;
    const requested = fields.requested as
      | { cursor?: unknown; anchor?: unknown }
      | undefined;
    if (
      typeof requested !== "object" || requested === null ||
      !isSeq(requested.cursor)
    ) {
      return undefined;
    }
    const request: CatchUpRequest = {
      cursor: requested.cursor,
      ...(requested.anchor === undefined
        ? {}
        : { anchor: requested.anchor as FeedAnchor }),
    };
    const refused = fields.refused as
      | { status?: unknown; body?: unknown }
      | undefined;
    if (refused !== undefined) {
      if (typeof refused?.status !== "number") return undefined;
      return {
        requested: request,
        refused: serveErrorFromReply(
          refused.status,
          refused.body,
          this.baseUrl,
        ),
      };
    }
    try {
      return { requested: request, page: changesPageOf(fields, "locks") };
    } catch {
      return undefined;
    }
  }

  /** false until a reply from serve itself has said it takes batches */
  takesCommitBatches(): boolean {
    return this.#takesCommitBatches ||
      this.#heardFeature(COMMIT_BATCH_FEATURE);
  }

  #exchange<T>(
    spec: RequestSpec,
    signal: AbortSignal,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    return withSpan(
      "swamp.datastore.v3.serve.request",
      {
        "http.request.method": spec.method,
        "http.route": routeTemplate(spec.path),
      },
      (span) => this.#exchangeIn(span, spec, signal, read),
    );
  }

  async #exchangeIn<T>(
    span: Span,
    spec: RequestSpec,
    signal: AbortSignal,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const url = this.#url(spec);
    const headers = this.#headers(spec);
    let resentOnFreshConnection = false;
    for (let attempt = 1;; attempt++) {
      span.setAttribute("swamp.datastore.v3.serve.attempts", attempt);
      signal.throwIfAborted();
      const latch = unreachableLatchOf(this.baseUrl);
      if (latch.aborted) {
        throw this.#latched("never", latch.reason, spec);
      }
      const timed = AbortSignal.any([
        signal,
        this.#timeoutSignal(
          serveRequestDeadlineMs(
            this.#timeoutMs,
            bodyBytesOf(spec.body),
          ),
        ),
        latch,
      ]);
      const bodyBytes = bodyBytesOf(spec.body);
      const responseMs = serveResponseDeadlineMs(
        answersWithoutConfirm(spec.method, spec.path)
          ? this.#responseBaseMs
          : this.#commitResponseBaseMs,
        this.#timeoutMs,
        bodyBytes,
        spec.serverWaitMs ?? 0,
      );
      const unanswered = new AbortController();
      const responseTimer = responseMs <
          serveRequestDeadlineMs(this.#timeoutMs, bodyBytes)
        ? setTimeout(() =>
          unanswered.abort(
            new DOMException(
              `Serve did not start its reply within ${responseMs} ms`,
              "TimeoutError",
            ),
          ), responseMs)
        : undefined;
      let response: Response;
      const sentAt = Date.now();
      try {
        response = await this.#fetch(url, {
          method: spec.method,
          headers,
          ...(spec.body === undefined ? {} : { body: spec.body }),
          signal: AbortSignal.any([timed, unanswered.signal]),
          ...this.#clientInit(),
        });
      } catch (error) {
        if (latch.aborted && !signal.aborted) {
          throw this.#latched("maybe", latch.reason, spec);
        }
        if (isTimeout(error)) {
          // its connection may reach a node that no longer answers: the next
          // request opens a fresh one, which the address may route elsewhere
          this.#retireConnection();
        }
        if (unanswered.signal.aborted && !signal.aborted) {
          if (isReadSpec(spec) && !resentOnFreshConnection) {
            resentOnFreshConnection = true;
            span.setAttribute(
              "swamp.datastore.v3.serve.resent_on_fresh_connection",
              true,
            );
            continue;
          }
        }
        throw this.#unreachable(error, signal, sentOf(error), true);
      } finally {
        clearTimeout(responseTimer);
      }
      // serve's clock, which judges a lease's expiry and corrects an offline
      // write's time while serve is unreachable; read before the 429 retry on
      // purpose: a throttled reply's Date is valid
      recordServeClock(
        this.baseUrl,
        response.headers.get("date"),
        sentAt,
        Date.now(),
      );
      span.setAttribute("http.response.status_code", response.status);
      if (response.status === 429 && attempt < this.#maxAttempts) {
        const wait = retryAfterMs(response.headers.get("retry-after"));
        if (wait !== undefined) {
          await response.body?.cancel();
          await abortableDelay(Math.min(wait, this.#maxRetryDelayMs), signal);
          continue;
        }
      }
      const logId = response.headers.get(SERVE_DATASTORE_LOG_HEADER) ??
        undefined;
      if (
        this.#logCheck !== undefined && (logId !== undefined || response.ok)
      ) {
        try {
          this.#logCheck(logId);
        } catch (error) {
          await response.body?.cancel();
          throw error;
        }
      }
      // a refused token never vouches for the principal it would act as
      if (
        logId !== undefined && response.status !== 401 &&
        response.status !== 403
      ) {
        const features = (response.headers.get(
          SERVE_DATASTORE_FEATURES_HEADER,
        ) ?? "").split(",").map((feature) => feature.trim());
        this.#takesStepStarts = features.includes(STEP_STARTS_FEATURE);
        this.#takesCommitBatches = features.includes(COMMIT_BATCH_FEATURE);
        heardFeatures.set(this.#heardKey(), features);
        this.#heardReply = true;
        this.#initiatorMode = initiatorModeOf(
          features,
          response.headers.get(SERVE_DATASTORE_PRINCIPAL_HEADER),
        );
        heardInitiators.set(this.#heardKey(), this.#initiatorMode);
      }
      const access = response.headers.get(SERVE_DATASTORE_ACCESS_HEADER);
      if (this.#accessCheck !== undefined && access !== null) {
        this.#accessCheck(access);
      }
      try {
        return await read(response);
      } catch (error) {
        // The request reached serve: a failure reading its reply may have
        // come after serve acted on it.
        if (latch.aborted && !signal.aborted) {
          throw this.#latched("maybe", latch.reason, spec);
        }
        throw this.#unreachable(error, signal, "maybe");
      }
    }
  }

  #latched(
    sent: "never" | "maybe",
    reason: unknown,
    spec: RequestSpec,
  ): ServeUnreachableError {
    return reason instanceof ServeLeaseLapsedLatch
      ? new ServeLeaseLapsedRequestError(this.baseUrl, sent, reason, {
        route: `${spec.method} ${routeTemplate(spec.path)}`,
        bodyBytes: bodyBytesOf(spec.body),
      })
      : new ServeUnreachableError(this.baseUrl, sent, reason);
  }

  async #refusal(response: Response, route: string): Promise<Error> {
    let body: unknown;
    try {
      body = await readBoundedJson(response, route, SERVE_ERROR_BODY_MAX_BYTES);
    } catch (error) {
      if (isNetworkFailure(error)) throw error;
      body = undefined;
    }
    return serveErrorFromReply(
      response.status,
      body,
      this.baseUrl,
      retryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  #unreachable(
    error: unknown,
    signal: AbortSignal,
    sent: "never" | "maybe",
    fromFetch = false,
  ): unknown {
    if (signal.aborted) return signal.reason ?? error;
    if (error instanceof ServeUpstreamError) return error;
    // A connection fetch never made (a refused or blocked port) is the
    // transport's even when it is not a network failure's shape.
    if (!isNetworkFailure(error) && !(fromFetch && sent === "never")) {
      return error;
    }
    return new ServeUnreachableError(this.baseUrl, sent, error);
  }

  #url(spec: RequestSpec): string {
    const url = new URL(
      `${this.baseUrl}/api/v1/datastore/${
        encodeURIComponent(this.namespace)
      }/${spec.path}`,
    );
    for (const [name, value] of Object.entries(spec.query ?? {})) {
      url.searchParams.set(name, value);
    }
    return url.toString();
  }

  #headers(spec: RequestSpec): Headers {
    const headers = new Headers(this.#extraHeaders);
    headers.set(
      SERVE_DATASTORE_FEATURES_HEADER,
      `${LEASE_OPS_FEATURE},${STEP_STARTS_FEATURE}`,
    );
    for (const [name, value] of Object.entries(spec.headers ?? {})) {
      headers.set(name, value);
    }
    if (this.#token !== undefined) {
      headers.set("authorization", `Bearer ${this.#token}`);
    }
    for (const [name, value] of Object.entries(injectTraceContext())) {
      headers.set(name, value);
    }
    return headers;
  }

  #clientInit(): { client?: Deno.HttpClient } {
    const make = this.#makeHttpClient ??
      (this.#ownConnectionAfterTimeout
        ? () => Deno.createHttpClient({})
        : undefined);
    if (make === undefined) return {};
    this.#httpClient ??= make();
    return { client: this.#httpClient };
  }

  #retireConnection(): void {
    if (this.#httpClient !== undefined) {
      this.#retiredClients.push(this.#httpClient);
      this.#httpClient = undefined;
    }
    // the process-wide pool may hold more connections to the same node
    if (this.#makeHttpClient === undefined) {
      this.#ownConnectionAfterTimeout = true;
    }
  }
}

// Span attributes leave the machine through an OTLP exporter, so a route
// names its kind of resource, never a partition, chunk, lease or txn id.
export function routeTemplate(path: string): string {
  const [head, id, ...rest] = path.split("/");
  if (id === undefined || path === "chunks/has") return path;
  return [head, `{${ROUTE_PARAMS[head] ?? "id"}}`, ...rest].join("/");
}

const ROUTE_PARAMS: Readonly<Record<string, string>> = {
  chunks: "sha256",
  locks: "leaseId",
  partitions: "partition",
  quarantine: "txnId",
};

/** A partition's path segment: its key, encoded once more than serve decodes. */
function partitionPath(partition: PartitionKey): string {
  return `partitions/${encodeURIComponent(partition.toString())}`;
}

function leaseOf(body: unknown): LockLease {
  const fields = typeof body === "object" && body !== null
    ? body as Record<string, unknown>
    : {};
  if (
    typeof fields.leaseId !== "string" || typeof fields.lockKey !== "string" ||
    typeof fields.ttlMs !== "number" || typeof fields.expiresAt !== "string"
  ) {
    throw invalidReply("locks", "leaseId, lockKey, ttlMs and expiresAt");
  }
  if (fields.fence !== undefined && !isSeq(fields.fence)) {
    throw invalidReply("locks", "a fence that is a non-negative integer");
  }
  let floor: DataNameMarks[] | undefined;
  if (fields.floor !== undefined) {
    if (!Array.isArray(fields.floor)) {
      throw invalidReply("locks", "a floor that is a list of data names");
    }
    try {
      floor = fields.floor.map(dataNameMarksFromJSON);
    } catch {
      throw invalidReply("locks", "a well-formed floor");
    }
  }
  return {
    leaseId: fields.leaseId,
    lockKey: fields.lockKey,
    ttlMs: fields.ttlMs,
    expiresAt: fields.expiresAt,
    ...(fields.fence === undefined ? {} : { fence: fields.fence as number }),
    ...(floor === undefined ? {} : { floor }),
    ...(isSeq(fields.holdMs) ? { holdMs: fields.holdMs } : {}),
  };
}

function leaseListingOf(body: unknown): ServeLeaseListing {
  const fields = typeof body === "object" && body !== null
    ? body as Record<string, unknown>
    : {};
  if (!Array.isArray(fields.leases)) throw invalidReply("locks", "leases");
  const leases = fields.leases.map((raw): ServeLeaseEntry => {
    const lease = typeof raw === "object" && raw !== null
      ? raw as Record<string, unknown>
      : {};
    if (
      typeof lease.lockKey !== "string" ||
      (lease.heldBy !== "caller" && lease.heldBy !== "other") ||
      typeof lease.expiresAt !== "string"
    ) {
      throw invalidReply("locks", "each lease's lockKey, heldBy and expiresAt");
    }
    const holder = leaseHolderOf(lease.holder);
    return {
      lockKey: lease.lockKey,
      heldBy: lease.heldBy,
      expiresAt: lease.expiresAt,
      ...(holder === undefined ? {} : { holder }),
    };
  });
  return { leases, truncated: fields.truncated === true };
}

/** a malformed holder is left out, so the reply reads as an older serve's */
function leaseHolderOf(raw: unknown): ServeLeaseHolder | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const fields = raw as Record<string, unknown>;
  if (
    typeof fields.principal !== "string" ||
    typeof fields.explicit !== "boolean" ||
    typeof fields.expiresAt !== "string" ||
    Number.isNaN(Date.parse(fields.expiresAt))
  ) {
    return undefined;
  }
  return {
    principal: fields.principal,
    explicit: fields.explicit,
    expiresAt: fields.expiresAt,
  };
}

function changesPageOf(
  body: Record<string, unknown>,
  route: string,
): ChangesPage {
  if (
    !Array.isArray(body.changes) || !isSeq(body.cursor) ||
    typeof body.more !== "boolean"
  ) {
    throw invalidReply(route, "changes, cursor and more");
  }
  const changes: ChangeEntry[] = [];
  for (const entry of body.changes) {
    const fields = entry as { cursor?: unknown; commit?: unknown } | null;
    if (
      fields === null || typeof fields !== "object" || !isSeq(fields.cursor)
    ) {
      throw invalidReply(route, "each change's cursor");
    }
    changes.push({ cursor: fields.cursor, commit: fields.commit });
  }
  const anchor = anchorVerdictOf(body.anchor);
  return {
    changes,
    cursor: body.cursor,
    more: body.more,
    ...(anchor === undefined ? {} : { anchor }),
  };
}

function anchorVerdictOf(value: unknown): AnchorVerdict | undefined {
  const fields = value as
    | { verdict?: unknown; serveHead?: unknown; serveTxnId?: unknown }
    | null
    | undefined;
  switch (fields?.verdict) {
    case "held":
    case "unchecked":
      return { verdict: fields.verdict };
    case "behind":
      return isSeq(fields.serveHead)
        ? { verdict: "behind", serveHead: fields.serveHead }
        : undefined;
    case "other-commit":
      return typeof fields.serveTxnId === "string"
        ? { verdict: "other-commit", serveTxnId: fields.serveTxnId }
        : undefined;
    default:
      return undefined;
  }
}

function frameCommit(
  envelope: CommitEnvelope,
  chunks: readonly CommitChunk[],
): Uint8Array<ArrayBuffer> {
  return encodeCommitBody({
    expectedSeq: envelope.expectedSeq,
    txnId: envelope.txnId,
    ...(envelope.fence === undefined ? {} : { fence: envelope.fence }),
    ...(envelope.lease === undefined ? {} : { lease: envelope.lease }),
    ops: envelope.ops,
    chunks: chunks.map((chunk) => ({
      sha256: chunk.sha256,
      size: chunk.bytes.byteLength,
    })),
  }, chunks);
}

function commitReplyOf(
  body: Record<string, unknown> | null | undefined,
  route: string,
): CommitReply {
  if (typeof body !== "object" || body === null || !isSeq(body.seq)) {
    throw invalidReply(route, "seq");
  }
  return {
    seq: body.seq,
    duplicate: body.duplicate === true,
    ...(typeof body.warning === "string" ? { warning: body.warning } : {}),
    ...(typeof body.commit === "object" && body.commit !== null
      ? { commit: body.commit }
      : {}),
    ...(typeof body.parentTxnId === "string"
      ? { parentTxnId: body.parentTxnId }
      : {}),
  };
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

function invalidReply(route: string, wanted: string): ServeUpstreamError {
  return new ServeUpstreamError(
    200,
    "invalid_response",
    `Serve's reply to ${route} is missing ${wanted}`,
  );
}

function pageMaxBytes(limit: number | undefined): number {
  return limit === 1 ? MAX_WRITTEN_COMMIT_REPLY_BYTES : SERVE_PAGE_MAX_BYTES;
}

function rangeBytes(range: ChunkRange): number {
  return range.end === undefined
    ? Math.max(0, CHUNK_BYTES - range.start)
    : Math.max(0, range.end - range.start + 1);
}

/**
 * A reply's body, read as it arrives and counted: past `maxBytes` the body
 * is cancelled and the reply refused. `Content-Length` is not consulted,
 * since serve sets it.
 */
async function readBounded(
  response: Response,
  route: string,
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ServeReplyTooLargeError(response.status, route, maxBytes);
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0];
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function readBoundedJson(
  response: Response,
  route: string,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBounded(response, route, maxBytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function ownBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : new Uint8Array(bytes);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownBuffer(bytes)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\s*\d{1,9}\s*$/.test(header)) return undefined;
  return Number(header.trim());
}

function retryAfterMs(header: string | null): number | undefined {
  const seconds = retryAfterSeconds(header);
  if (seconds !== undefined) return seconds * 1000;
  if (header === null) return undefined;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const NEVER_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
]);

const MAX_CAUSE_DEPTH = 8;

/**
 * Whether a fetch that threw may have sent its request. "never" only when
 * the error, or one it wraps, says the connection was never made: Deno's
 * `client error (Connect)` (refused, a failed lookup or TLS handshake), a
 * `ConnectionRefused`, or a Node-style connect code. A timeout, a reset
 * and a connection closed mid-request may all have reached serve.
 */
function sentOf(error: unknown): "never" | "maybe" {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!(current instanceof Error)) return "maybe";
    if (neverConnected(current)) return "never";
    if (current instanceof AggregateError) {
      return current.errors.length > 0 &&
          current.errors.every((member) => sentOf(member) === "never")
        ? "never"
        : "maybe";
    }
    current = current.cause;
  }
  return "maybe";
}

function neverConnected(error: Error): boolean {
  if (error instanceof Deno.errors.ConnectionRefused) return true;
  if (error instanceof Deno.errors.AddrNotAvailable) return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && NEVER_SENT_CODES.has(code)) return true;
  // Deno refuses a port the fetch standard blocks (1, 6000, …) before it
  // connects.
  if (error.message.includes("are blocked")) return true;
  return error.message.includes("client error (Connect)") ||
    error.message.includes("dns error") ||
    error.message.includes("tcp connect error");
}

/**
 * ownConnection keeps the client off the shared fetch pool, so its requests
 * never queue behind another client's upload
 */
export function serveDatastoreClientFor(
  target: ServeUpstreamTarget,
  namespace: string,
  options: { readonly ownConnection?: boolean } = {},
): ServeDatastoreClient {
  const caCerts = target.caCerts !== undefined && target.caCerts.length > 0
    ? [...target.caCerts]
    : undefined;
  return new ServeDatastoreClient({
    baseUrl: target.serverUrl,
    namespace,
    ...(target.token !== undefined ? { token: target.token } : {}),
    extraHeaders: target.extraHeaders,
    ...(caCerts !== undefined || options.ownConnection === true
      ? {
        httpClient: () =>
          Deno.createHttpClient(caCerts !== undefined ? { caCerts } : {}),
      }
      : {}),
  });
}
