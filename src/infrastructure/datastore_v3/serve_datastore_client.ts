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
import { MAX_INLINE_BYTES } from "../../domain/datastore_v3/op.ts";
import { chunksToWire } from "../../domain/datastore_v3/quarantine.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { MAX_RECORD_KEY_LENGTH } from "../../domain/datastore_v3/record_key.ts";
import {
  type ChunkDeclaration,
  ChunkHashMismatchError,
  encodeCommitBody,
} from "./chunk_ingest.ts";
import { isNetworkFailure } from "./network_failure.ts";
import { recordServeClock } from "./serve_offline.ts";
import {
  serveErrorFromReply,
  ServeReplyTooLargeError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";

export const MAX_HAS_HASHES = 1024;

export const DEFAULT_SERVE_TIMEOUT_MS = 30_000;

export const DEFAULT_MAX_ATTEMPTS = 3;

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

export const LEASE_OPS_FEATURE = "lease-ops";

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
  readonly maxAttempts?: number;
  readonly maxRetryDelayMs?: number;
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
}

export interface ChunkRange {
  readonly start: number;
  readonly end?: number;
}

export interface LockLease {
  readonly leaseId: string;
  readonly lockKey: string;
  readonly ttlMs: number;
  /**
   * a fenced lease's fence; absent when serve does not fence leases (an older
   * serve), so the lease is unfenced
   */
  readonly expiresAt: string;
  readonly fence?: number;
  /**
   * a fenced model lease's data-version floor when taken: each data name's
   * marks, which the holder allocates versions above
   */
  readonly floor?: readonly DataNameMarks[];
  readonly holdMs?: number;
}

export interface ServeLeaseEntry {
  readonly lockKey: string;
  readonly heldBy: "caller" | "other";
  readonly expiresAt: string;
}

export interface ServeLeaseListing {
  readonly leases: readonly ServeLeaseEntry[];
  readonly truncated: boolean;
}

export type LockAcquireReply =
  | { readonly acquired: true; readonly lease: LockLease }
  | {
    readonly acquired: false;
    readonly heldBy: string;
    readonly message: string;
  };

interface RequestSpec {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array<ArrayBuffer> | string;
}

export class ServeDatastoreClient {
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
  #accessCheck: ((fingerprint: string) => void) | undefined;

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

  close(): void {
    this.#httpClient?.close();
    this.#httpClient = undefined;
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
    const framed = encodeCommitBody({
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
    options: { readonly holdMs?: number } = {},
  ): Promise<LockAcquireReply> {
    return await this.#exchange(
      {
        method: "POST",
        path: "locks",
        headers: { "content-type": "application/json" },
        // an older serve ignores `fenced` and grants an unfenced lease; an
        // explicit lease is held for `holdMs` between renewals
        body: JSON.stringify(
          options.holdMs === undefined
            ? { lockKey, ttlMs, waitMs, fenced: true }
            : { lockKey, waitMs, fenced: true, holdMs: options.holdMs },
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
            await readBoundedJson(
              response,
              "locks",
              SERVE_LEASE_REPLY_MAX_BYTES,
            ),
          ),
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
      const sentAt = Date.now();
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
      // serve's clock, which judges a lease's expiry and corrects an offline
      // write's time while serve is unreachable; read before the 429 retry on
      // purpose: a throttled reply's Date is valid
      recordServeClock(
        this.baseUrl,
        response.headers.get("date"),
        sentAt,
        Date.now(),
      );
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
      const access = response.headers.get(SERVE_DATASTORE_ACCESS_HEADER);
      if (this.#accessCheck !== undefined && access !== null) {
        this.#accessCheck(access);
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
    headers.set(SERVE_DATASTORE_FEATURES_HEADER, LEASE_OPS_FEATURE);
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
    return {
      lockKey: lease.lockKey,
      heldBy: lease.heldBy,
      expiresAt: lease.expiresAt,
    };
  });
  return { leases, truncated: fields.truncated === true };
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
