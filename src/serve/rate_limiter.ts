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

import { splitServerToken } from "./token_auth.ts";
import {
  parseDelegatedSecret,
  RESERVED_TOKEN_NAMES,
} from "../domain/access/delegated_token.ts";
import { integrationIdOfCredential } from "../domain/access/integration_credential.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { processRuntimeSlot } from "../infrastructure/runtime/process_runtime.ts";

const logger = getSwampLogger(["serve", "rate-limit"]);

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const MAX_PRINCIPAL_ATTEMPTS = 5;
const PRINCIPAL_WINDOW_MS = 60_000;

const MAX_IP_BURST = 50;
const IP_BURST_WINDOW_MS = 60_000;

const MAX_ENTRIES = 10_000;

const principalBuckets = new Map<string, RateLimitEntry>();
const ipBurstBuckets = new Map<string, RateLimitEntry>();

function sweepExpired(buckets: Map<string, RateLimitEntry>): void {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now > entry.resetAt) buckets.delete(key);
  }
}

/** a refusing entry outlives fresher ones, so filling the map never lifts a lockout */
function evictOldest(
  buckets: Map<string, RateLimitEntry>,
  maxAttempts: number,
): void {
  for (const [key, entry] of buckets) {
    if (entry.count < maxAttempts) {
      buckets.delete(key);
      return;
    }
  }
  buckets.delete(buckets.keys().next().value!);
}

function checkBucket(
  buckets: Map<string, RateLimitEntry>,
  key: string,
  maxAttempts: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    if (buckets.size >= MAX_ENTRIES) sweepExpired(buckets);
    if (buckets.size >= MAX_ENTRIES) evictOldest(buckets, maxAttempts);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  entry.count++;
  if (entry.count <= maxAttempts) {
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
  };
}

/**
 * Every key ends in the address, so knowing a principal only locks it out from
 * the caller's own address; the principal is the one the credential claims,
 * never a prefix that every credential of its kind shares.
 */
export function failedAttemptKey(
  credential: string | null,
  address: string,
  scope?: string,
): string {
  const principal = credential === null
    ? undefined
    : claimedPrincipal(credential);
  return [scope, principal, `address:${address}`]
    .filter((part) => part !== undefined)
    .join("|");
}

function claimedPrincipal(credential: string): string | undefined {
  const delegated = parseDelegatedSecret(credential);
  if (delegated !== null) return `delegation:${delegated.delegationId}`;
  const integrationId = integrationIdOfCredential(credential);
  if (integrationId !== undefined) {
    return `integration-credential:${integrationId}`;
  }
  const split = splitServerToken(credential);
  // a reserved prefix that failed to parse names no principal of its own
  if (split === null || RESERVED_TOKEN_NAMES.includes(split.name)) {
    return undefined;
  }
  return `token:${split.name}`;
}

export function checkIpBurst(ip: string): RateLimitResult {
  return checkBucket(ipBurstBuckets, ip, MAX_IP_BURST, IP_BURST_WINDOW_MS);
}

/** Refuses a key that already holds the maximum failures; never counts. */
export function checkFailedAttempts(key: string): RateLimitResult {
  const now = Date.now();
  const entry = principalBuckets.get(key);
  if (
    !entry || now > entry.resetAt || entry.count < MAX_PRINCIPAL_ATTEMPTS
  ) {
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
  };
}

export function recordFailedAttempt(key: string): RateLimitResult {
  return checkBucket(
    principalBuckets,
    key,
    MAX_PRINCIPAL_ATTEMPTS,
    PRINCIPAL_WINDOW_MS,
  );
}

function clearFailedAttempts(key: string): void {
  const entry = principalBuckets.get(key);
  if (entry) {
    entry.count = 0;
  }
}

const pendingAttempts = new Map<string, number>();

export type FailedAttemptGuard<T> =
  | { readonly limited: true; readonly retryAfterSeconds: number }
  | { readonly limited: false; readonly result: T };

/**
 * Only a failed attempt counts, so concurrent requests on one valid credential
 * are never refused by each other; the in-flight cap bounds what concurrent
 * wrong guesses cost before any of them has failed.
 */
export async function limitFailedAttempts<T extends { readonly ok: boolean }>(
  key: string,
  attempt: () => Promise<T>,
): Promise<FailedAttemptGuard<T>> {
  const failures = checkFailedAttempts(key);
  if (!failures.allowed) {
    return { limited: true, retryAfterSeconds: failures.retryAfterSeconds };
  }
  const pending = pendingAttempts.get(key) ?? 0;
  if (pending >= MAX_PENDING_ATTEMPTS) {
    return { limited: true, retryAfterSeconds: 1 };
  }
  pendingAttempts.set(key, pending + 1);
  try {
    const result = await attempt();
    if (result.ok) clearFailedAttempts(key);
    else {
      recordFailedAttempt(key);
      const entry = principalBuckets.get(key);
      if (entry?.count === MAX_PRINCIPAL_ATTEMPTS) {
        logger.warn(
          "{key} failed authentication {count} times in a row; it is refused on this node for {seconds}s",
          {
            key,
            count: entry.count,
            seconds: Math.ceil((entry.resetAt - Date.now()) / 1000),
          },
        );
      }
    }
    return { limited: false, result };
  } finally {
    // released on every path, or a throwing attempt would hold its slot forever
    const left = (pendingAttempts.get(key) ?? 1) - 1;
    if (left > 0) pendingAttempts.set(key, left);
    else pendingAttempts.delete(key);
  }
}

export function pendingAttemptCount(): number {
  return pendingAttempts.size;
}

const MAX_DASHBOARD_SESSION_GUESSES = 50;
const MAX_PENDING_DASHBOARD_SESSION_GUESSES = 50;

const dashboardSessionGuessBuckets = new Map<string, RateLimitEntry>();
const pendingDashboardSessionGuesses = new Map<string, number>();

/**
 * The session endpoint's own per-IP limit, apart from checkIpBurst, so other
 * routes' traffic never refuses a restore. Only a failed guess counts, and a
 * success never clears: a valid cookie would otherwise reset an IP's guesses.
 */
export async function limitDashboardSessionGuesses<
  T extends { readonly ok: boolean },
>(
  ip: string,
  attempt: () => Promise<T>,
): Promise<FailedAttemptGuard<T>> {
  const now = Date.now();
  const entry = dashboardSessionGuessBuckets.get(ip);
  if (
    entry && now <= entry.resetAt &&
    entry.count >= MAX_DASHBOARD_SESSION_GUESSES
  ) {
    return {
      limited: true,
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
    };
  }
  const pending = pendingDashboardSessionGuesses.get(ip) ?? 0;
  if (pending >= MAX_PENDING_DASHBOARD_SESSION_GUESSES) {
    return { limited: true, retryAfterSeconds: 1 };
  }
  pendingDashboardSessionGuesses.set(ip, pending + 1);
  try {
    // a throw is a store fault, not a guess, so it records nothing
    const result = await attempt();
    if (!result.ok) {
      checkBucket(
        dashboardSessionGuessBuckets,
        ip,
        MAX_DASHBOARD_SESSION_GUESSES,
        IP_BURST_WINDOW_MS,
      );
    }
    return { limited: false, result };
  } finally {
    const left = (pendingDashboardSessionGuesses.get(ip) ?? 1) - 1;
    if (left > 0) pendingDashboardSessionGuesses.set(ip, left);
    else pendingDashboardSessionGuesses.delete(ip);
  }
}

export const PRINCIPAL_RATE_PER_MINUTE = 600;

export const PRINCIPAL_RATE_BURST = 200;

/** a valid principal is never accepted past its burst on a rate-limited route */
export const MAX_PENDING_ATTEMPTS = PRINCIPAL_RATE_BURST;

export const MAX_PRINCIPAL_RATE_BUCKETS = 10_000;

export const DATA_PLANE_RATE_PER_MINUTE = 6_000;

/** sized for a member's fan-out: 32 to 64 parallel steps of a few requests each */
export const DATA_PLANE_RATE_BURST = 1_024;

export type RateCheck = (principalId: string, now?: number) => RateLimitResult;

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

/** a token bucket per principal, least recently used dropped past maxBuckets */
export class PrincipalRateLimiter {
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #burst: number;
  readonly #perMs: number;
  readonly #maxBuckets: number;

  constructor(options: {
    readonly burst: number;
    readonly perMinute: number;
    readonly maxBuckets?: number;
  }) {
    this.#burst = options.burst;
    this.#perMs = options.perMinute / 60_000;
    this.#maxBuckets = options.maxBuckets ?? MAX_PRINCIPAL_RATE_BUCKETS;
  }

  check(principalId: string, now: number = Date.now()): RateLimitResult {
    let bucket = this.#buckets.get(principalId);
    if (bucket === undefined) {
      if (this.#buckets.size >= this.#maxBuckets) this.#sweepIdle(now);
      if (this.#buckets.size >= this.#maxBuckets) {
        const oldest = this.#buckets.keys().next().value!;
        this.#buckets.delete(oldest);
      }
      bucket = { tokens: this.#burst, updatedAt: now };
    } else {
      // Re-inserted below, so map order stays least recently used first.
      this.#buckets.delete(principalId);
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(
        this.#burst,
        bucket.tokens + elapsed * this.#perMs,
      );
      bucket.updatedAt = Math.max(now, bucket.updatedAt);
    }
    this.#buckets.set(principalId, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((1 - bucket.tokens) / this.#perMs / 1000),
      ),
    };
  }

  get size(): number {
    return this.#buckets.size;
  }

  clear(): void {
    this.#buckets.clear();
  }

  /** Drops buckets that have refilled to the burst: dropping them is lossless. */
  #sweepIdle(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * this.#perMs;
      if (refilled >= this.#burst) this.#buckets.delete(key);
    }
  }
}

const generalRate = new PrincipalRateLimiter({
  burst: PRINCIPAL_RATE_BURST,
  perMinute: PRINCIPAL_RATE_PER_MINUTE,
});

const dataPlaneRate = processRuntimeSlot(() =>
  new PrincipalRateLimiter({
    burst: DATA_PLANE_RATE_BURST,
    perMinute: DATA_PLANE_RATE_PER_MINUTE,
  })
);

export function checkPrincipalRate(
  principalId: string,
  now: number = Date.now(),
): RateLimitResult {
  return generalRate.check(principalId, now);
}

/** the datastore data plane's own bucket, so a member's fan-out never spends the general one */
export function checkPrincipalDataPlaneRate(
  principalId: string,
  now: number = Date.now(),
): RateLimitResult {
  return dataPlaneRate().check(principalId, now);
}

export function principalRateBucketCount(): number {
  return generalRate.size;
}

export function resetRateLimitState(): void {
  principalBuckets.clear();
  pendingAttempts.clear();
  ipBurstBuckets.clear();
  dashboardSessionGuessBuckets.clear();
  pendingDashboardSessionGuesses.clear();
  generalRate.clear();
  dataPlaneRate().clear();
}
