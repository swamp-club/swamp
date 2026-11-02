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
import {
  abortableSleep,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_RETRY_AFTER_SECONDS,
  parseRateLimitScope,
  parseRetryAfter,
  type Sleep,
} from "./rate_limit.ts";

const logger = getLogger(["swamp", "http", "retry"]);

export const MAX_TRANSIENT_RETRIES = 5;
export const TRANSIENT_BACKOFF_MS: readonly number[] = [
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
];
const BACKOFF_JITTER_RATIO = 0.25;
const RETRY_AFTER_JITTER_MS = 1000;
export const REGISTRY_ATTEMPT_TIMEOUT_MS = 15_000;
/**
 * sized to fit two capped Retry-After waits plus jitter, so rate-limit handling
 * keeps the reach it had before transient retries
 */
export const REGISTRY_READ_BUDGET_MS = 150_000;

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const STATUS_TEXT: Record<number, string> = {
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export type RetryReason =
  | { kind: "timeout"; afterMs: number }
  | { kind: "connection"; message: string }
  | { kind: "status"; status: number }
  | { kind: "rate_limit"; scope: string };

export interface RetryNotice {
  service: string;
  method: string;
  target: string;
  reason: RetryReason;
  waitMs: number;
  retry: number;
  maxRetries: number;
}

export interface RetryOutcome {
  method: string;
  target: string;
  attempts: number;
  elapsedMs: number;
}

export interface RetriedResponse {
  response: Response;
  outcome: RetryOutcome;
}

/**
 * timeout: last attempt hit its own timeout; connection: could not connect or
 * lost the body; deadline: caller's signal timed out; aborted: caller's signal
 * aborted otherwise
 */
export class TransientRequestError extends Error {
  constructor(
    readonly kind: "timeout" | "connection" | "deadline" | "aborted",
    readonly outcome: RetryOutcome,
    readonly attemptTimeoutMs: number,
    options: { cause: unknown },
  ) {
    super(
      `${outcome.method} ${outcome.target} failed (${kind}): ${
        causeMessage(options.cause)
      }`,
      { cause: options.cause },
    );
    this.name = "TransientRequestError";
  }
}

export interface TransientRetryOptions {
  method?: string;
  /** The request's origin and path, never its query string. */
  target: string;
  service?: string;
  signal?: AbortSignal;
  attemptTimeoutMs?: number;
  budgetMs?: number;
  sleep?: Sleep;
  random?: () => number;
  now?: () => number;
  onRetry?: (notice: RetryNotice) => void;
}

/**
 * Strip the query string, fragment and userinfo from a URL or path, so a
 * signed URL's credentials never reach a message.
 */
export function describeRequestTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0];
  }
}

/**
 * Deno's fetch errors embed the full request URL, signature and all, so every
 * URL in the text is reduced to origin and path
 */
export function redactUrls(text: string): string {
  return text.replace(
    /\bhttps?:\/\/[^\s()<>"']+/g,
    (url) => describeRequestTarget(url),
  );
}

export function causeMessage(cause: unknown): string {
  return redactUrls(cause instanceof Error ? cause.message : String(cause));
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function describeReason(reason: RetryReason): string {
  switch (reason.kind) {
    case "timeout":
      return `timed out after ${formatElapsed(reason.afterMs)}`;
    case "connection":
      return `connection failed (${reason.message})`;
    case "status": {
      const text = STATUS_TEXT[reason.status];
      return text ? `HTTP ${reason.status} ${text}` : `HTTP ${reason.status}`;
    }
    case "rate_limit":
      return `rate limited (scope ${reason.scope})`;
  }
}

export function formatRetryNotice(notice: RetryNotice): string {
  const wait = Math.max(1, Math.round(notice.waitMs / 1000));
  return `${notice.service}: ${notice.method} ${notice.target} ${
    describeReason(notice.reason)
  } · retrying in ${wait}s (retry ${notice.retry}/${notice.maxRetries})`;
}

function logRetryNotice(notice: RetryNotice): void {
  // Passed as a plain message rather than a tagged template so the line
  // reads as prose instead of a quoted value; braces are escaped because
  // LogTape treats them as placeholders.
  logger.warn(
    formatRetryNotice(notice).replaceAll("{", "{{").replaceAll("}", "}}"),
  );
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/**
 * one loop, retry ceiling and budget cover every kind so rate-limit and
 * transient retries never multiply; attempt must build a fresh request each
 * call; a UserError from attempt is rethrown
 */
export async function fetchWithTransientRetry(
  attempt: (signal: AbortSignal) => Promise<Response>,
  options: TransientRetryOptions,
): Promise<RetriedResponse> {
  const method = (options.method ?? "GET").toUpperCase();
  const retryable = IDEMPOTENT_METHODS.has(method);
  const service = options.service ?? "swamp-club registry";
  const attemptTimeoutMs = options.attemptTimeoutMs ??
    REGISTRY_ATTEMPT_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? REGISTRY_READ_BUDGET_MS;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const onRetry = options.onRetry ?? logRetryNotice;
  const callerSignal = options.signal;
  const start = now();
  let attempts = 0;
  let rateLimitRetries = 0;

  const outcome = (): RetryOutcome => ({
    method,
    target: options.target,
    attempts,
    elapsedMs: now() - start,
  });

  const canRetry = (waitMs: number): boolean =>
    retryable && attempts <= MAX_TRANSIENT_RETRIES &&
    now() - start + waitMs < budgetMs;

  const waitBeforeRetry = async (
    reason: RetryReason,
    waitMs: number,
  ): Promise<void> => {
    onRetry({
      service,
      method,
      target: options.target,
      reason,
      waitMs,
      retry: attempts,
      maxRetries: MAX_TRANSIENT_RETRIES,
    });
    try {
      await sleep(waitMs, callerSignal);
    } catch (error) {
      throw new TransientRequestError(
        isTimeout(error) ? "deadline" : "aborted",
        outcome(),
        attemptTimeoutMs,
        { cause: error },
      );
    }
  };

  const backoff = () => {
    const base = TRANSIENT_BACKOFF_MS[
      Math.min(attempts - 1, TRANSIENT_BACKOFF_MS.length - 1)
    ];
    return base + Math.floor(random() * base * BACKOFF_JITTER_RATIO);
  };

  while (true) {
    const remaining = budgetMs - (now() - start);
    const timeoutMs = Math.max(1, Math.min(attemptTimeoutMs, remaining));
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    attempts++;

    let res: Response;
    try {
      res = await attempt(signal);
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (callerSignal?.aborted) {
        throw new TransientRequestError(
          isTimeout(callerSignal.reason) ? "deadline" : "aborted",
          outcome(),
          attemptTimeoutMs,
          { cause: error },
        );
      }
      const timedOut = isTimeout(error) || timeout.aborted;
      const reason: RetryReason = timedOut
        ? { kind: "timeout", afterMs: timeoutMs }
        : { kind: "connection", message: causeMessage(error) };
      const waitMs = backoff();
      if (canRetry(waitMs)) {
        await waitBeforeRetry(reason, waitMs);
        continue;
      }
      throw new TransientRequestError(
        timedOut ? "timeout" : "connection",
        outcome(),
        attemptTimeoutMs,
        { cause: error },
      );
    }

    if (res.status === 429) {
      const retryAfterSeconds = parseRetryAfter(
        res.headers.get("retry-after"),
      );
      if (
        rateLimitRetries >= MAX_RATE_LIMIT_RETRIES ||
        retryAfterSeconds === undefined ||
        retryAfterSeconds > MAX_RATE_LIMIT_RETRY_AFTER_SECONDS
      ) {
        return { response: res, outcome: outcome() };
      }
      const scope = parseRateLimitScope(res.headers.get("x-ratelimit-scope")) ??
        "unknown";
      const waitMs = retryAfterSeconds * 1000 +
        Math.floor(random() * RETRY_AFTER_JITTER_MS);
      if (!canRetry(waitMs)) return { response: res, outcome: outcome() };
      await res.body?.cancel();
      rateLimitRetries++;
      await waitBeforeRetry({ kind: "rate_limit", scope }, waitMs);
      continue;
    }

    if (RETRYABLE_STATUSES.has(res.status)) {
      const retryAfterSeconds = parseRetryAfter(
        res.headers.get("retry-after"),
      );
      if (
        retryAfterSeconds !== undefined &&
        retryAfterSeconds > MAX_RATE_LIMIT_RETRY_AFTER_SECONDS
      ) {
        return { response: res, outcome: outcome() };
      }
      const waitMs = retryAfterSeconds !== undefined
        ? Math.max(retryAfterSeconds * 1000, backoff())
        : backoff();
      if (!canRetry(waitMs)) return { response: res, outcome: outcome() };
      await res.body?.cancel();
      await waitBeforeRetry({ kind: "status", status: res.status }, waitMs);
      continue;
    }

    return { response: res, outcome: outcome() };
  }
}
