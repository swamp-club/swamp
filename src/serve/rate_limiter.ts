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

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

type RateLimitResult =
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
    if (buckets.size >= MAX_ENTRIES) {
      const oldest = buckets.keys().next().value!;
      buckets.delete(oldest);
    }
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

export function rateLimitKey(
  token: string | null,
  ip: string,
): string {
  if (token !== null) {
    const split = splitServerToken(token);
    if (split !== null) {
      return `token:${split.name}`;
    }
  }
  return `ip:${ip}`;
}

export function checkIpBurst(ip: string): RateLimitResult {
  return checkBucket(ipBurstBuckets, ip, MAX_IP_BURST, IP_BURST_WINDOW_MS);
}

export function checkRateLimit(key: string): RateLimitResult {
  return checkBucket(
    principalBuckets,
    key,
    MAX_PRINCIPAL_ATTEMPTS,
    PRINCIPAL_WINDOW_MS,
  );
}

export function clearRateLimit(key: string): void {
  const entry = principalBuckets.get(key);
  if (entry) {
    entry.count = 0;
  }
}

/** Sustained requests per minute one authenticated principal may make. */
export const PRINCIPAL_RATE_PER_MINUTE = 600;

/** Requests one authenticated principal may make in a burst. */
export const PRINCIPAL_RATE_BURST = 200;

/** Token buckets kept at most; the least recently used is evicted past it. */
export const MAX_PRINCIPAL_RATE_BUCKETS = 10_000;

const PRINCIPAL_RATE_PER_MS = PRINCIPAL_RATE_PER_MINUTE / 60_000;

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

const principalRateBuckets = new Map<string, TokenBucket>();

/** Drops buckets that have refilled to the burst: dropping them is lossless. */
function sweepIdleRateBuckets(now: number): void {
  for (const [key, bucket] of principalRateBuckets) {
    const refilled = bucket.tokens +
      (now - bucket.updatedAt) * PRINCIPAL_RATE_PER_MS;
    if (refilled >= PRINCIPAL_RATE_BURST) principalRateBuckets.delete(key);
  }
}

/**
 * Throttles every request of an authenticated principal with a token bucket
 * of {@link PRINCIPAL_RATE_BURST} tokens refilled at
 * {@link PRINCIPAL_RATE_PER_MINUTE} per minute. Each allowed request takes
 * one token. The bucket map holds at most {@link MAX_PRINCIPAL_RATE_BUCKETS}:
 * idle (full) buckets go first, then the least recently used.
 */
export function checkPrincipalRate(
  principalId: string,
  now: number = Date.now(),
): RateLimitResult {
  let bucket = principalRateBuckets.get(principalId);
  if (bucket === undefined) {
    if (principalRateBuckets.size >= MAX_PRINCIPAL_RATE_BUCKETS) {
      sweepIdleRateBuckets(now);
    }
    if (principalRateBuckets.size >= MAX_PRINCIPAL_RATE_BUCKETS) {
      const oldest = principalRateBuckets.keys().next().value!;
      principalRateBuckets.delete(oldest);
    }
    bucket = { tokens: PRINCIPAL_RATE_BURST, updatedAt: now };
  } else {
    // Re-inserted below, so map order stays least recently used first.
    principalRateBuckets.delete(principalId);
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(
      PRINCIPAL_RATE_BURST,
      bucket.tokens + elapsed * PRINCIPAL_RATE_PER_MS,
    );
    bucket.updatedAt = Math.max(now, bucket.updatedAt);
  }
  principalRateBuckets.set(principalId, bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((1 - bucket.tokens) / PRINCIPAL_RATE_PER_MS / 1000),
    ),
  };
}

/** The number of per-principal token buckets held (for tests and metrics). */
export function principalRateBucketCount(): number {
  return principalRateBuckets.size;
}

export function resetRateLimitState(): void {
  principalBuckets.clear();
  ipBurstBuckets.clear();
  principalRateBuckets.clear();
}
