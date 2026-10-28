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
 * The client of serve's datastore API (swamp-club#3985): what a team's
 * laptops and CI write a v3 datastore through when serve holds its writer
 * lease. One method per route under `/api/v1/datastore/{namespace}/`; see
 * "Team mode: serve's datastore API" in `design/enablers/datastores.md` and
 * `src/serve/datastore_api.ts` for the server.
 *
 * Every request runs under the caller's `AbortSignal` and a per-attempt
 * timeout. A 429 with a `Retry-After` is retried a bounded number of times;
 * every other refusal is thrown as the error
 * {@link serveErrorFromReply} maps it to. A request that got no reply is
 * thrown as a {@link ServeUnreachableError}, which says whether the request
 * may have reached serve.
 *
 * @module
 */

import { normalizeServerUrl } from "../../domain/auth/server_url.ts";
import { CHUNK_BYTES } from "../../domain/datastore_v3/chunk_store.ts";
import { MAX_COMMIT_OPS } from "../../domain/datastore_v3/commit.ts";
import { MAX_FIELD_LENGTH as MAX_INTENT_FIELD_LENGTH } from "../../domain/datastore_v3/intent.ts";
import {
  type ObservedBaseEntry,
  observedBaseEntryFromJSON,
  type ObservedBasePage,
} from "../../domain/datastore_v3/observed_base.ts";
import { MAX_INLINE_BYTES } from "../../domain/datastore_v3/op.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { MAX_RECORD_KEY_LENGTH } from "../../domain/datastore_v3/record_key.ts";
import {
  type ChunkDeclaration,
  ChunkHashMismatchError,
  encodeCommitBody,
} from "./chunk_ingest.ts";
import { isNetworkFailure } from "./network_failure.ts";
import {
  serveErrorFromReply,
  ServeReplyTooLargeError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";

/** The most hashes serve answers in one `chunks/has` request. */
export const MAX_HAS_HASHES = 1024;

/** The request timeout when neither the caller nor the environment sets one. */
export const DEFAULT_SERVE_TIMEOUT_MS = 30_000;

/** How many times a request is sent when serve keeps answering 429. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** The longest a 429's `Retry-After` is waited for. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

/**
 * The most bytes of an error reply's body the client reads
 * (swamp-club#4062). Past it the refusal is mapped from its status alone.
 */
export const SERVE_ERROR_BODY_MAX_BYTES = 64 * 1024;

/**
 * The most bytes the client reads of a small JSON reply: `chunks/has`,
 * a chunk upload, a commit and a lease. `chunks/has`, the largest,
 * answers at most {@link MAX_HAS_HASHES} hashes, about 70 KiB.
 */
export const SERVE_REPLY_MAX_BYTES = 1024 * 1024;

/** The most bytes the client reads of a page of more than one commit. */
export const SERVE_PAGE_MAX_BYTES = 64 * 1024 * 1024;

/** The most UTF-8 bytes one UTF-16 unit of text JSON does not escape takes. */
const UTF8_BYTES_PER_UNIT = 3;

/**
 * The most strings a put's intent carries: `data.rename`'s model type and
 * id, name and new name.
 */
const MAX_INTENT_STRINGS = 4;

/** A put's kind, expect, access, and JSON's own quotes and separators. */
const PUT_OP_SYNTAX_ALLOWANCE = 1024;

/**
 * The largest JSON one put op with inline content takes: the longest base64
 * of {@link MAX_INLINE_BYTES}, a key of {@link MAX_RECORD_KEY_LENGTH}
 * UTF-16 units, and an intent of {@link MAX_INTENT_STRINGS} strings of the
 * longest an intent accepts.
 */
export const MAX_PUT_OP_REPLY_BYTES = Math.ceil(MAX_INLINE_BYTES / 3) * 4 +
  MAX_RECORD_KEY_LENGTH * UTF8_BYTES_PER_UNIT +
  MAX_INTENT_STRINGS * MAX_INTENT_FIELD_LENGTH * UTF8_BYTES_PER_UNIT +
  PUT_OP_SYNTAX_ALLOWANCE;

/**
 * The bytes a page's and a commit's own fields take around its ops: its
 * namespace, txnId, writer and principal of at most 1024 units each.
 */
const COMMIT_REPLY_HEADER_ALLOWANCE = 32 * 1024;

/**
 * The most bytes the client reads of a page of one commit: the largest
 * commit serve writes. Serve's own runs commit through the commit-log unit
 * of work, which splits a partition's changes only at
 * {@link MAX_COMMIT_OPS}, so that commit is larger than any a client can
 * post (an envelope of at most 4 MiB). About 350 MiB.
 */
export const MAX_WRITTEN_COMMIT_REPLY_BYTES =
  MAX_COMMIT_OPS * MAX_PUT_OP_REPLY_BYTES + COMMIT_REPLY_HEADER_ALLOWANCE;

/** The media type of a framed commit body. */
export const COMMIT_CONTENT_TYPE = "application/vnd.swamp.commit+v1";

/**
 * The header every datastore API reply to an authenticated caller carries
 * with the id of the commit log serve serves (swamp-club#4049).
 */
export const SERVE_DATASTORE_LOG_HEADER = "x-swamp-datastore-log";

/**
 * The per-request timeout `SWAMP_SERVE_TIMEOUT_MS` sets (a positive
 * integer of milliseconds), as the remote-run client reads it, else
 * {@link DEFAULT_SERVE_TIMEOUT_MS}.
 */
export function serveRequestTimeoutMs(): number {
  const env = Deno.env.get("SWAMP_SERVE_TIMEOUT_MS");
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SERVE_TIMEOUT_MS;
}

/** How a {@link ServeDatastoreClient} reaches serve. */
export interface ServeDatastoreClientOptions {
  /** Serve's `http(s)` origin; normalized, trailing slashes dropped. */
  readonly baseUrl: string;
  /**
   * The datastore's storage namespace, as `storageNamespaceOf` names it;
   * `_default` when empty or omitted.
   */
  readonly namespace?: string;
  /** Serve token, sent as a bearer token; no header without one. */
  readonly token?: string;
  /**
   * Makes the HTTP client requests go through (a private CA, say). Called
   * once, on the first request, never at construction.
   */
  readonly httpClient?: () => Deno.HttpClient;
  /** Per-attempt timeout; {@link serveRequestTimeoutMs} by default. */
  readonly timeoutMs?: number;
  /** Headers sent with every request (an auth proxy's, say). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Replaces the global `fetch`, for tests. */
  readonly fetch?: typeof fetch;
  /** Attempts per request while serve answers 429; at least 1. */
  readonly maxAttempts?: number;
  /** Cap on a single `Retry-After` wait. */
  readonly maxRetryDelayMs?: number;
}

/** A chunk a commit request carries. */
export interface CommitChunk {
  /** Lowercase 64-hex SHA-256 of `bytes`. */
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/**
 * A commit's envelope, as serve takes it. The `chunks` it lists are the
 * ones {@link ServeDatastoreClient.postCommit} carries, so they are not
 * given here.
 */
export interface CommitEnvelope {
  /** The partition head the commit was built on. */
  readonly expectedSeq: number;
  /** Lowercase UUID; a retry of the commit carries the same one. */
  readonly txnId: string;
  readonly fence?: number;
  /** The commit's ops, as `opToJSON` writes them. */
  readonly ops: readonly unknown[];
}

/** What serve answered a commit with. */
export interface CommitReply {
  readonly seq: number;
  /** The txnId had landed already: this is that commit's seq. */
  readonly duplicate: boolean;
  /** Serve committed, and something after the commit needs attention. */
  readonly warning?: string;
}

/** A page of a partition's commits. */
export interface PartitionCommitsPage {
  /** The partition's head at serve. */
  readonly head: number;
  /** Commit JSON, for `Commit.fromJSON`. */
  readonly commits: readonly unknown[];
}

/** One commit of the changes feed. */
export interface ChangeEntry {
  readonly cursor: number;
  /** Commit JSON, for `Commit.fromJSON`. */
  readonly commit: unknown;
}

/** A page of the changes feed. */
export interface ChangesPage {
  readonly changes: readonly ChangeEntry[];
  /** The cursor to read the next page from. */
  readonly cursor: number;
  /** Whether serve has more past `cursor`. */
  readonly more: boolean;
}

/** An inclusive byte range of a chunk; `end` omitted reads to its end. */
export interface ChunkRange {
  readonly start: number;
  readonly end?: number;
}

/** A lease on one of serve's locks, as serve granted or renewed it. */
export interface LockLease {
  readonly leaseId: string;
  /** The canonical lock key serve holds. */
  readonly lockKey: string;
  readonly ttlMs: number;
  /** When the lease ends unless renewed, by serve's clock. */
  readonly expiresAt: string;
}

/** What serve answered a lock request with. */
export type LockAcquireReply =
  | { readonly acquired: true; readonly lease: LockLease }
  | {
    readonly acquired: false;
    /** Who holds it, as far as serve tells: this caller, another, or serve. */
    readonly heldBy: string;
    readonly message: string;
  };

/** A request, as the client sends it. */
interface RequestSpec {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path below `/api/v1/datastore/{namespace}/`, already encoded. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array<ArrayBuffer> | string;
}

/** The client of serve's datastore API. Holds no state but its HTTP client. */
export class ServeDatastoreClient {
  /** Serve's normalized origin. */
  readonly baseUrl: string;
  readonly namespace: string;
  readonly #token: string | undefined;
  readonly #makeHttpClient: (() => Deno.HttpClient) | undefined;
  #httpClient: Deno.HttpClient | undefined;
  readonly #timeoutMs: number;
  readonly #extraHeaders: Readonly<Record<string, string>>;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #maxRetryDelayMs: number;
  #logCheck: ((logId: string | undefined) => void) | undefined;

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
    this.#maxAttempts = Math.max(
      1,
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    );
    this.#maxRetryDelayMs = options.maxRetryDelayMs ??
      DEFAULT_MAX_RETRY_DELAY_MS;
  }

  /** Closes the HTTP client, if one was made. */
  close(): void {
    this.#httpClient?.close();
    this.#httpClient = undefined;
  }

  /**
   * The hashes of `hashes` serve holds and the caller may reference, asked
   * {@link MAX_HAS_HASHES} at a time.
   */
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

  /**
   * A chunk's bytes, or the inclusive `range` of them; null when serve has
   * no such chunk the caller may read. A whole chunk is checked against
   * its hash.
   */
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

  /**
   * Sends one commit with the chunks it carries, framed as serve reads it.
   * The envelope's `chunks` are `chunks`' `{sha256, size}`, in order.
   */
  async postCommit(
    partition: PartitionKey,
    envelope: CommitEnvelope,
    chunks: readonly CommitChunk[],
    signal: AbortSignal,
  ): Promise<CommitReply> {
    const framed = encodeCommitBody({
      expectedSeq: envelope.expectedSeq,
      txnId: envelope.txnId,
      ...(envelope.fence === undefined ? {} : { fence: envelope.fence }),
      ops: envelope.ops,
      chunks: chunks.map((chunk) => ({
        sha256: chunk.sha256,
        size: chunk.bytes.byteLength,
      })),
    }, chunks);
    const body = await this.#json({
      method: "POST",
      path: `${partitionPath(partition)}/commits`,
      headers: { "content-type": COMMIT_CONTENT_TYPE },
      body: framed,
    }, signal);
    if (!isSeq(body.seq)) throw invalidReply("commits", "seq");
    return {
      seq: body.seq,
      duplicate: body.duplicate === true,
      ...(typeof body.warning === "string" ? { warning: body.warning } : {}),
    };
  }

  /** A partition's commits after seq `after`, at most `limit` of them. */
  async partitionCommits(
    partition: PartitionKey,
    after: number,
    signal: AbortSignal,
    limit?: number,
  ): Promise<PartitionCommitsPage> {
    const body = await this.#json(
      {
        method: "GET",
        path: `${partitionPath(partition)}/commits`,
        query: {
          after: String(after),
          ...(limit === undefined ? {} : { limit: String(limit) }),
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

  /** The commits the caller may read since `cursor`, at most `limit`. */
  async changes(
    cursor: number,
    signal: AbortSignal,
    limit?: number,
  ): Promise<ChangesPage> {
    const body = await this.#json(
      {
        method: "GET",
        path: "changes",
        query: {
          cursor: String(cursor),
          ...(limit === undefined ? {} : { limit: String(limit) }),
        },
      },
      signal,
      pageMaxBytes(limit),
    );
    if (
      !Array.isArray(body.changes) || !isSeq(body.cursor) ||
      typeof body.more !== "boolean"
    ) {
      throw invalidReply("changes", "changes, cursor and more");
    }
    const changes: ChangeEntry[] = [];
    for (const entry of body.changes) {
      const fields = entry as { cursor?: unknown; commit?: unknown } | null;
      if (
        fields === null || typeof fields !== "object" || !isSeq(fields.cursor)
      ) {
        throw invalidReply("changes", "each change's cursor");
      }
      changes.push({ cursor: fields.cursor, commit: fields.commit });
    }
    return { changes, cursor: body.cursor, more: body.more };
  }

  /**
   * One page of serve's compacted base after `after` (undefined to start),
   * at most `limit` entries the caller may read with their partitions'
   * (swamp-club#4006). The reply is read under the page byte limit, and
   * every entry is checked: one of another shape, or outside `namespace`,
   * refuses the whole page.
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
   * Asks serve for its lock `lockKey` (`data/{type}/{id}/.lock` or
   * `workflow-run-claims/{runId}/.lock`, with no namespace), for `ttlMs`,
   * serve waiting up to `waitMs` while another holder has it. A lock still
   * held after that is `acquired: false`, not an error.
   */
  async acquireLock(
    lockKey: string,
    ttlMs: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<LockAcquireReply> {
    return await this.#exchange(
      {
        method: "POST",
        path: "locks",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockKey, ttlMs, waitMs }),
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
            return {
              acquired: false,
              heldBy: typeof body.heldBy === "string" ? body.heldBy : "other",
              message: typeof body.message === "string"
                ? body.message
                : `${lockKey} is held`,
            };
          }
          throw serveErrorFromReply(409, body, this.baseUrl);
        }
        if (!response.ok) throw await this.#refusal(response, "locks");
        return {
          acquired: true,
          lease: leaseOf(
            await readBoundedJson(response, "locks", SERVE_REPLY_MAX_BYTES),
          ),
        };
      },
    );
  }

  /**
   * Extends the lease `leaseId` by `ttlMs`; undefined when serve holds no
   * such lease for the caller any more (it expired or was released).
   */
  async renewLock(
    leaseId: string,
    ttlMs: number,
    signal: AbortSignal,
  ): Promise<LockLease | undefined> {
    return await this.#exchange(
      {
        method: "PUT",
        path: `locks/${encodeURIComponent(leaseId)}`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ttlMs }),
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

  /**
   * Releases the lease `leaseId`: true once released, false when serve
   * held no such lease (it expired, or was released already).
   */
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

  /** The per-attempt timeout every request runs under. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Has every reply checked by `check` before it is read
   * (swamp-club#4049): with the log id the reply names, or undefined for a
   * success that names none. A refusal that names none (one serve's
   * datastore API did not answer) is not checked. A throw refuses the
   * reply.
   */
  checkLog(check: (logId: string | undefined) => void): void {
    this.#logCheck = check;
  }

  /**
   * A request whose success is a JSON object of at most `maxBytes`
   * ({@link SERVE_REPLY_MAX_BYTES} by default).
   */
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
   * Sends `spec`, retrying a 429 that carries a `Retry-After`, and hands
   * the reply to `read` under the same timeout. A failure with no reply is
   * a {@link ServeUnreachableError}; the caller's abort is rethrown as it.
   */
  async #exchange<T>(
    spec: RequestSpec,
    signal: AbortSignal,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const url = this.#url(spec);
    const headers = this.#headers(spec);
    for (let attempt = 1;; attempt++) {
      signal.throwIfAborted();
      const timed = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.#timeoutMs),
      ]);
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: spec.method,
          headers,
          ...(spec.body === undefined ? {} : { body: spec.body }),
          signal: timed,
          ...this.#clientInit(),
        });
      } catch (error) {
        throw this.#unreachable(error, signal, sentOf(error), true);
      }
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
      try {
        return await read(response);
      } catch (error) {
        // The request reached serve: a failure reading its reply may have
        // come after serve acted on it.
        throw this.#unreachable(error, signal, "maybe");
      }
    }
  }

  /**
   * The error a reply that is not a success maps to. A body past
   * {@link SERVE_ERROR_BODY_MAX_BYTES} is not read: the status alone maps.
   */
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

  /**
   * `error` as thrown to the caller: the caller's own abort as it is, a
   * network failure as a {@link ServeUnreachableError}, anything else (a
   * refusal, a bug) unchanged.
   */
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
    for (const [name, value] of Object.entries(spec.headers ?? {})) {
      headers.set(name, value);
    }
    if (this.#token !== undefined) {
      headers.set("authorization", `Bearer ${this.#token}`);
    }
    return headers;
  }

  #clientInit(): { client?: Deno.HttpClient } {
    if (this.#makeHttpClient === undefined) return {};
    this.#httpClient ??= this.#makeHttpClient();
    return { client: this.#httpClient };
  }
}

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
  return {
    leaseId: fields.leaseId,
    lockKey: fields.lockKey,
    ttlMs: fields.ttlMs,
    expiresAt: fields.expiresAt,
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

/**
 * The most bytes read of a page of `limit` commits: one commit's largest
 * at limit 1, else {@link SERVE_PAGE_MAX_BYTES}. A caller that names no
 * limit gets serve's page of up to 1000.
 */
function pageMaxBytes(limit: number | undefined): number {
  return limit === 1 ? MAX_WRITTEN_COMMIT_REPLY_BYTES : SERVE_PAGE_MAX_BYTES;
}

/** The bytes a 206 for `range` holds at most. */
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

/** A reply's body as JSON, read through {@link readBounded}. */
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

/** `Retry-After` as whole seconds, when it is delay-seconds. */
function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\s*\d{1,9}\s*$/.test(header)) return undefined;
  return Number(header.trim());
}

/** `Retry-After` (delay-seconds or an HTTP date) as milliseconds. */
function retryAfterMs(header: string | null): number | undefined {
  const seconds = retryAfterSeconds(header);
  if (seconds !== undefined) return seconds * 1000;
  if (header === null) return undefined;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Waits `ms`, or rejects with the signal's reason once it aborts. */
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

/** Node-style codes of a connection that was never made. */
const NEVER_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
]);

/** How far {@link sentOf} follows `cause` links. */
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
