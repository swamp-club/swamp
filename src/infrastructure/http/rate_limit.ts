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

import { getLogger } from "@logtape/logtape";
import { UserError } from "../../domain/errors.ts";

const logger = getLogger(["swamp", "http", "rate-limit"]);

export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;

  // Numeric form (delta-seconds) — handle entirely here so we don't fall
  // through to Date.parse, which would interpret "-1" as a past date.
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return Math.ceil(asNumber);
    }
    return undefined;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const seconds = Math.ceil((date - Date.now()) / 1000);
  return seconds > 0 ? seconds : 0;
}

/**
 * which limit a 429 came from: anonymous is per IP, principal is per
 * credential, global is server-wide
 */
export type RateLimitScope = "anonymous" | "principal" | "global";

export interface RateLimitInfo {
  retryAfterSeconds?: number;
  scope?: RateLimitScope;
}

export function parseRateLimitScope(
  value: unknown,
): RateLimitScope | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "anonymous" || normalized === "principal" ||
      normalized === "global"
    ? normalized
    : undefined;
}

const MAX_RATE_LIMIT_BODY_BYTES = 4096;

/**
 * the header wins; the body is read only when it is missing, and bounded, so a
 * large proxy body can't stall the call
 */
export async function readRateLimit(res: Response): Promise<RateLimitInfo> {
  const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
  const headerScope = parseRateLimitScope(
    res.headers.get("x-ratelimit-scope"),
  );
  if (headerScope !== undefined) {
    await res.body?.cancel();
    return { retryAfterSeconds, scope: headerScope };
  }
  return { retryAfterSeconds, scope: await readBodyScope(res) };
}

async function readBodyScope(
  res: Response,
): Promise<RateLimitScope | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_RATE_LIMIT_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(0, MAX_RATE_LIMIT_BODY_BYTES)),
    );
    return typeof parsed === "object" && parsed !== null
      ? parseRateLimitScope((parsed as Record<string, unknown>).scope)
      : undefined;
  } catch {
    return undefined;
  }
}

export function hasCredential(headers: Headers): boolean {
  return headers.has("x-api-key") || headers.has("authorization");
}

/**
 * the sign-in hint appears only when signing in could help: the anonymous
 * limit, or an unknown scope with no credential on the request
 */
export function rateLimitError(
  info: RateLimitInfo & { credentialed: boolean },
): UserError {
  const wait = info.retryAfterSeconds !== undefined
    ? ` Retry in ${info.retryAfterSeconds}s.`
    : "";
  switch (info.scope) {
    case "principal":
      return new UserError(
        `Rate limit exceeded for this API key or login.${wait} Requests made with the same credential share one limit.`,
      );
    case "global":
      return new UserError(
        `swamp-club is receiving too many requests.${wait}`,
      );
    case "anonymous":
      return new UserError(
        `Rate limit exceeded.${wait} Sign in with 'swamp auth login' for a higher limit.`,
      );
    default:
      return new UserError(
        info.credentialed
          ? `Rate limit exceeded.${wait}`
          : `Rate limit exceeded.${wait} Sign in with 'swamp auth login' for a higher limit.`,
      );
  }
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const MAX_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
export const MAX_RATE_LIMIT_RETRIES = 2;
const RETRY_JITTER_MS = 1000;

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

export interface RateLimitRetryOptions {
  method?: string;
  signal?: AbortSignal;
  sleep?: Sleep;
  random?: () => number;
}

/**
 * attempt must build a fresh request and timeout each call; the last response
 * is returned, still a 429 when retries are exhausted or disallowed
 */
export async function fetchWithRateLimitRetry(
  attempt: () => Promise<Response>,
  options: RateLimitRetryOptions = {},
): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  for (let retry = 0;; retry++) {
    const res = await attempt();
    if (
      res.status !== 429 || !IDEMPOTENT_METHODS.has(method) ||
      retry >= MAX_RATE_LIMIT_RETRIES
    ) {
      return res;
    }
    const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
    if (
      retryAfterSeconds === undefined ||
      retryAfterSeconds > MAX_RATE_LIMIT_RETRY_AFTER_SECONDS
    ) {
      return res;
    }
    const scope = parseRateLimitScope(res.headers.get("x-ratelimit-scope")) ??
      "unknown";
    await res.body?.cancel();
    const attemptNumber = retry + 2;
    const maxAttempts = MAX_RATE_LIMIT_RETRIES + 1;
    logger
      .warn`swamp-club rate limit hit (scope ${scope}); retrying in ${retryAfterSeconds}s, attempt ${attemptNumber} of ${maxAttempts}`;
    await sleep(
      retryAfterSeconds * 1000 + Math.floor(random() * RETRY_JITTER_MS),
      options.signal,
    );
  }
}
