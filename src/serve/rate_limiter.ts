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

export function resetRateLimitState(): void {
  principalBuckets.clear();
  ipBurstBuckets.clear();
}
