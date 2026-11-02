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

import { assert, assertEquals } from "@std/assert";
import {
  checkIpBurst,
  checkPrincipalRate,
  checkRateLimit,
  clearRateLimit,
  MAX_PRINCIPAL_RATE_BUCKETS,
  PRINCIPAL_RATE_BURST,
  PRINCIPAL_RATE_PER_MINUTE,
  principalRateBucketCount,
  rateLimitKey,
  resetRateLimitState,
} from "./rate_limiter.ts";

Deno.test("rateLimitKey: returns token-name key for valid token format", () => {
  assertEquals(rateLimitKey("mytoken.secret123", "10.0.0.1"), "token:mytoken");
});

Deno.test("rateLimitKey: returns IP key for null token", () => {
  assertEquals(rateLimitKey(null, "10.0.0.1"), "ip:10.0.0.1");
});

Deno.test("rateLimitKey: returns IP key for malformed token", () => {
  assertEquals(rateLimitKey("no-dot-here", "10.0.0.1"), "ip:10.0.0.1");
});

Deno.test("rateLimitKey: returns IP key for empty token", () => {
  assertEquals(rateLimitKey("", "10.0.0.1"), "ip:10.0.0.1");
});

Deno.test("rateLimitKey: returns IP key for token starting with dot", () => {
  assertEquals(rateLimitKey(".secret", "10.0.0.1"), "ip:10.0.0.1");
});

Deno.test("rateLimitKey: returns IP key for token ending with dot", () => {
  assertEquals(rateLimitKey("name.", "10.0.0.1"), "ip:10.0.0.1");
});

Deno.test("checkRateLimit: allows up to 5 attempts for a key", () => {
  resetRateLimitState();
  const key = "token:test-allows-five";
  for (let i = 0; i < 5; i++) {
    const result = checkRateLimit(key);
    assertEquals(result.allowed, true);
  }
});

Deno.test("checkRateLimit: blocks on 6th attempt for same key", () => {
  resetRateLimitState();
  const key = "token:test-blocks-sixth";
  for (let i = 0; i < 5; i++) {
    checkRateLimit(key);
  }
  const result = checkRateLimit(key);
  assertEquals(result.allowed, false);
});

Deno.test("checkRateLimit: different token names are independent", () => {
  resetRateLimitState();
  const keyA = "token:worker-a";
  const keyB = "token:worker-b";

  for (let i = 0; i < 5; i++) {
    checkRateLimit(keyA);
  }
  const resultA = checkRateLimit(keyA);
  assertEquals(resultA.allowed, false);

  const resultB = checkRateLimit(keyB);
  assertEquals(resultB.allowed, true);
});

Deno.test("checkRateLimit: rate-limited token does not block different token on same IP", () => {
  resetRateLimitState();
  const badToken = "token:bad-worker";
  const goodToken = "token:good-user";

  for (let i = 0; i < 6; i++) {
    checkRateLimit(badToken);
  }

  const result = checkRateLimit(goodToken);
  assertEquals(result.allowed, true);
});

Deno.test("checkRateLimit: IP-keyed fallback works like token keys", () => {
  resetRateLimitState();
  const ipKey = "ip:192.168.1.1";
  for (let i = 0; i < 5; i++) {
    const result = checkRateLimit(ipKey);
    assertEquals(result.allowed, true);
  }
  const result = checkRateLimit(ipKey);
  assertEquals(result.allowed, false);
});

Deno.test("clearRateLimit: resets count for token-name key", () => {
  resetRateLimitState();
  const key = "token:clear-test";
  for (let i = 0; i < 5; i++) {
    checkRateLimit(key);
  }
  assertEquals(checkRateLimit(key).allowed, false);

  clearRateLimit(key);

  assertEquals(checkRateLimit(key).allowed, true);
});

Deno.test("clearRateLimit: no-op for unknown key", () => {
  resetRateLimitState();
  clearRateLimit("token:nonexistent");
});

Deno.test("checkIpBurst: allows up to 50 requests from one IP", () => {
  resetRateLimitState();
  const ip = "10.0.0.99";
  for (let i = 0; i < 50; i++) {
    const result = checkIpBurst(ip);
    assertEquals(result.allowed, true);
  }
});

Deno.test("checkIpBurst: blocks on 51st request from same IP", () => {
  resetRateLimitState();
  const ip = "10.0.0.100";
  for (let i = 0; i < 50; i++) {
    checkIpBurst(ip);
  }
  const result = checkIpBurst(ip);
  assertEquals(result.allowed, false);
});

Deno.test("checkIpBurst: different IPs are independent", () => {
  resetRateLimitState();
  const ipA = "10.0.0.101";
  const ipB = "10.0.0.102";

  for (let i = 0; i < 50; i++) {
    checkIpBurst(ipA);
  }
  assertEquals(checkIpBurst(ipA).allowed, false);

  assertEquals(checkIpBurst(ipB).allowed, true);
});

Deno.test("checkIpBurst: prevents bypass via token name enumeration", () => {
  resetRateLimitState();
  const ip = "10.0.0.200";

  for (let i = 0; i < 50; i++) {
    checkIpBurst(ip);
  }
  assertEquals(checkIpBurst(ip).allowed, false);
});

Deno.test("checkPrincipalRate: allows the burst, then refuses with a retry hint", () => {
  resetRateLimitState();
  const now = 1_000_000;
  for (let i = 0; i < PRINCIPAL_RATE_BURST; i++) {
    assertEquals(checkPrincipalRate("p-burst", now).allowed, true);
  }
  const refused = checkPrincipalRate("p-burst", now);
  assertEquals(refused.allowed, false);
  if (!refused.allowed) {
    assertEquals(refused.retryAfterSeconds, 1);
  }
});

Deno.test("checkPrincipalRate: refills at the sustained rate", () => {
  resetRateLimitState();
  const now = 5_000_000;
  for (let i = 0; i < PRINCIPAL_RATE_BURST; i++) {
    checkPrincipalRate("p-refill", now);
  }
  assertEquals(checkPrincipalRate("p-refill", now).allowed, false);
  const perToken = 60_000 / PRINCIPAL_RATE_PER_MINUTE;
  assertEquals(
    checkPrincipalRate("p-refill", now + perToken - 1).allowed,
    false,
  );
  assertEquals(checkPrincipalRate("p-refill", now + perToken).allowed, true);
  assertEquals(checkPrincipalRate("p-refill", now + perToken).allowed, false);
  const later = now + 10 * 60_000;
  for (let i = 0; i < PRINCIPAL_RATE_BURST; i++) {
    assertEquals(checkPrincipalRate("p-refill", later).allowed, true);
  }
  assertEquals(checkPrincipalRate("p-refill", later).allowed, false);
});

Deno.test("checkPrincipalRate: principals are independent", () => {
  resetRateLimitState();
  const now = 9_000_000;
  for (let i = 0; i <= PRINCIPAL_RATE_BURST; i++) {
    checkPrincipalRate("p-a", now);
  }
  assertEquals(checkPrincipalRate("p-a", now).allowed, false);
  assertEquals(checkPrincipalRate("p-b", now).allowed, true);
});

Deno.test("checkPrincipalRate: a clock going backward does not mint tokens", () => {
  resetRateLimitState();
  const now = 20_000_000;
  for (let i = 0; i < PRINCIPAL_RATE_BURST; i++) {
    checkPrincipalRate("p-back", now);
  }
  assertEquals(checkPrincipalRate("p-back", now - 60_000).allowed, false);
  assertEquals(checkPrincipalRate("p-back", now).allowed, false);
});

Deno.test("checkPrincipalRate: is cleared by resetRateLimitState", () => {
  resetRateLimitState();
  const now = 30_000_000;
  for (let i = 0; i < PRINCIPAL_RATE_BURST; i++) {
    checkPrincipalRate("p-reset", now);
  }
  assertEquals(checkPrincipalRate("p-reset", now).allowed, false);
  resetRateLimitState();
  assertEquals(principalRateBucketCount(), 0);
  assertEquals(checkPrincipalRate("p-reset", now).allowed, true);
});

Deno.test("checkPrincipalRate: does not touch the auth-failure or IP limiters", () => {
  resetRateLimitState();
  const now = 40_000_000;
  for (let i = 0; i <= PRINCIPAL_RATE_BURST; i++) {
    checkPrincipalRate("token:shared", now);
  }
  assertEquals(checkRateLimit("token:shared").allowed, true);
  assertEquals(checkIpBurst("token:shared").allowed, true);
});

Deno.test("checkPrincipalRate: the bucket map stays bounded, evicting idle buckets first", () => {
  resetRateLimitState();
  const now = 50_000_000;
  for (let i = 0; i < PRINCIPAL_RATE_BURST; i++) {
    checkPrincipalRate("p-active", now);
  }
  for (let i = 0; i < MAX_PRINCIPAL_RATE_BUCKETS + 50; i++) {
    checkPrincipalRate(`p-flood-${i}`, now);
    assert(principalRateBucketCount() <= MAX_PRINCIPAL_RATE_BUCKETS);
  }
  assertEquals(principalRateBucketCount(), MAX_PRINCIPAL_RATE_BUCKETS);
  resetRateLimitState();

  for (let i = 0; i < MAX_PRINCIPAL_RATE_BUCKETS - 1; i++) {
    checkPrincipalRate(`p-idle-${i}`, now);
  }
  const later = now + 60_000;
  for (let i = 0; i < PRINCIPAL_RATE_BURST; i++) {
    checkPrincipalRate("p-busy", later - 1_000);
  }
  assertEquals(principalRateBucketCount(), MAX_PRINCIPAL_RATE_BUCKETS);
  assertEquals(checkPrincipalRate("p-new", later).allowed, true);
  assertEquals(principalRateBucketCount(), 2);
  for (let i = 0; i < 10; i++) {
    assertEquals(checkPrincipalRate("p-busy", later).allowed, true);
  }
  assertEquals(checkPrincipalRate("p-busy", later).allowed, false);
});
