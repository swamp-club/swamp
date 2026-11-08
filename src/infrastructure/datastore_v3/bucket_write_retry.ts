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

import { AsyncLocalStorage } from "node:async_hooks";
import type { WritableDatastoreControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import type { DatastoreStorage } from "../../domain/datastore/datastore_storage.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { abortableSleep, type Sleep } from "../http/rate_limit.ts";

const logger = getSwampLogger(["datastore", "v3", "bucket"]);

/** kept under the writer lease heartbeat interval, a third of its TTL */
export const BUCKET_WRITE_RETRY_BUDGET_MS = 5_000;
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;
const MAX_CAUSE_DEPTH = 5;

export type BucketWriteRefusal = "rate_limited" | "unavailable";

export const BUCKET_WRITE_CODES: Readonly<Record<BucketWriteRefusal, string>> =
  {
    rate_limited: "bucket_write_rate_limited",
    unavailable: "bucket_write_unavailable",
  };

function statusOf(error: object): number | undefined {
  const candidate = error as {
    httpStatusCode?: unknown;
    status?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  for (
    const value of [
      candidate.httpStatusCode,
      candidate.$metadata?.httpStatusCode,
      candidate.status,
    ]
  ) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

/**
 * a provider error, at any depth of its cause chain, that a later attempt may
 * get past: 429, or 503 (S3's SlowDown is its rate limit)
 */
export function bucketWriteRefusal(
  error: unknown,
): BucketWriteRefusal | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return undefined;
    const status = statusOf(current);
    const code = (current as { code?: unknown }).code;
    const message = current instanceof Error ? current.message : "";
    if (status === 429 || /\bHTTP 429\b/.test(message)) return "rate_limited";
    if (status === 503 || /\bHTTP 503\b/.test(message)) {
      return code === "SlowDown" || /\bSlowDown\b/.test(message)
        ? "rate_limited"
        : "unavailable";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const deadlines = new AsyncLocalStorage<number>();

/**
 * bucket writes made inside fn stop retrying at deadlineAt (epoch ms), if that
 * comes before their own budget runs out
 */
export function withBucketWriteDeadline<T>(
  deadlineAt: number,
  fn: () => Promise<T>,
): Promise<T> {
  const outer = deadlines.getStore();
  return deadlines.run(
    outer === undefined ? deadlineAt : Math.min(outer, deadlineAt),
    fn,
  );
}

export interface BucketWriteRetryDeps {
  readonly sleep: Sleep;
  readonly now: () => number;
  readonly random: () => number;
  readonly budgetMs: number;
}

const DEFAULT_DEPS: BucketWriteRetryDeps = {
  sleep: abortableSleep,
  now: () => Date.now(),
  random: Math.random,
  budgetMs: BUCKET_WRITE_RETRY_BUDGET_MS,
};

/**
 * runs write until it succeeds, fails with something a retry cannot fix, or
 * the budget (or an enclosing deadline) leaves no room for the next backoff;
 * the last error is thrown as it came
 */
async function retrying<T>(
  deps: BucketWriteRetryDeps,
  object: string,
  write: (attempt: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const startedAt = deps.now();
  const budgetEnd = startedAt + deps.budgetMs;
  const deadline = deadlines.getStore();
  const end = deadline === undefined
    ? budgetEnd
    : Math.min(budgetEnd, deadline);
  for (let attempt = 1;; attempt++) {
    try {
      const result = await write(attempt);
      if (attempt > 1) {
        logger
          .info`Bucket write to ${object} succeeded on attempt ${attempt}`;
      }
      return result;
    } catch (error) {
      const refusal = bucketWriteRefusal(error);
      if (refusal === undefined) throw error;
      const ceiling = Math.min(
        MAX_BACKOFF_MS,
        FIRST_BACKOFF_MS * 2 ** (attempt - 1),
      );
      const backoff = ceiling / 2 + deps.random() * (ceiling / 2);
      const code = BUCKET_WRITE_CODES[refusal];
      if (signal?.aborted === true || deps.now() + backoff > end) {
        logger
          .warn`Bucket write to ${object} failed (${code}) after ${attempt} attempt(s): ${error}`;
        throw error;
      }
      logger
        .info`Bucket write to ${object} was refused (${code}) on attempt ${attempt}; retrying in ${
        Math.round(backoff)
      }ms`;
      await deps.sleep(backoff, signal);
    }
  }
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  return a !== null && a.length === b.length &&
    a.every((byte, i) => byte === b[i]);
}

/**
 * replaces only the named methods; everything else, the optional capabilities
 * callers detect by name included, reaches the target bound to it
 */
function overriding<T extends object>(
  target: T,
  overrides: Partial<Record<keyof T, unknown>>,
): T {
  return new Proxy(target, {
    get(t, property) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property as keyof T];
      }
      const value = Reflect.get(t, property, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

function landed503(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const message = current instanceof Error ? current.message : "";
    if (statusOf(current) === 503 || /\bHTTP 503\b/.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * retries 429 and 503 on every write; a putIfAbsent that a 503 answered may
 * have landed, so its later false, or its final failure, reads the key back
 * and counts these exact bytes as this caller's own create
 */
export function retryingControlPlane(
  store: WritableDatastoreControlPlaneStore,
  deps: Partial<BucketWriteRetryDeps> = {},
): WritableDatastoreControlPlaneStore {
  const d = { ...DEFAULT_DEPS, ...deps };
  const holds = async (key: string, data: Uint8Array) =>
    sameBytes(await store.get(key), data);
  return overriding(store, {
    put: (key: string, data: Uint8Array) =>
      retrying(d, key, () => store.put(key, data)),
    delete: (key: string) => retrying(d, key, () => store.delete(key)),
    async putIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
      let ambiguous = false;
      try {
        return await retrying(d, key, async () => {
          try {
            return await store.putIfAbsent(key, data) ||
              (ambiguous && await holds(key, data));
          } catch (error) {
            if (landed503(error)) ambiguous = true;
            throw error;
          }
        });
      } catch (error) {
        if (ambiguous && await holds(key, data).catch(() => false)) {
          return true;
        }
        throw error;
      }
    },
  });
}

export function retryingStorage(
  storage: DatastoreStorage,
  deps: Partial<BucketWriteRetryDeps> = {},
): DatastoreStorage {
  const d = { ...DEFAULT_DEPS, ...deps };
  const touch = storage.touch;
  return overriding(storage, {
    put: (
      namespace: string,
      sha256: string,
      bytes: Uint8Array,
      signal: AbortSignal,
    ) =>
      retrying(
        d,
        `${namespace}/${sha256}`,
        () => storage.put(namespace, sha256, bytes, signal),
        signal,
      ),
    delete: (namespace: string, sha256: string, signal: AbortSignal) =>
      retrying(
        d,
        `${namespace}/${sha256}`,
        () => storage.delete(namespace, sha256, signal),
        signal,
      ),
    ...(touch !== undefined
      ? {
        touch: (
          namespace: string,
          hashes: readonly string[],
          signal: AbortSignal,
        ) =>
          retrying(
            d,
            `${namespace}/${hashes.length} chunk(s)`,
            () => touch.call(storage, namespace, hashes, signal),
            signal,
          ),
      }
      : {}),
  });
}
