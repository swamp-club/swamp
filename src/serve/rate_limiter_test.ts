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

import { assertEquals } from "@std/assert";
import {
  checkIpBurst,
  checkRateLimit,
  clearRateLimit,
  rateLimitKey,
  resetRateLimitState,
} from "./rate_limiter.ts";

// ── rateLimitKey ────────────────────────────────────────────────────────

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

// ── checkRateLimit (per-principal) ──────────────────────────────────────

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
  // keyA is now exhausted
  const resultA = checkRateLimit(keyA);
  assertEquals(resultA.allowed, false);

  // keyB should still be allowed
  const resultB = checkRateLimit(keyB);
  assertEquals(resultB.allowed, true);
});

Deno.test("checkRateLimit: rate-limited token does not block different token on same IP", () => {
  resetRateLimitState();
  const badToken = "token:bad-worker";
  const goodToken = "token:good-user";

  // Exhaust bad token's budget
  for (let i = 0; i < 6; i++) {
    checkRateLimit(badToken);
  }

  // Good token on same conceptual IP is unaffected
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

// ── clearRateLimit ──────────────────────────────────────────────────────

Deno.test("clearRateLimit: resets count for token-name key", () => {
  resetRateLimitState();
  const key = "token:clear-test";
  for (let i = 0; i < 5; i++) {
    checkRateLimit(key);
  }
  // Now at limit
  assertEquals(checkRateLimit(key).allowed, false);

  clearRateLimit(key);

  // Should be allowed again
  assertEquals(checkRateLimit(key).allowed, true);
});

Deno.test("clearRateLimit: no-op for unknown key", () => {
  resetRateLimitState();
  clearRateLimit("token:nonexistent");
});

// ── checkIpBurst ────────────────────────────────────────────────────────

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
  // ipA is exhausted
  assertEquals(checkIpBurst(ipA).allowed, false);

  // ipB is unaffected
  assertEquals(checkIpBurst(ipB).allowed, true);
});

Deno.test("checkIpBurst: prevents bypass via token name enumeration", () => {
  resetRateLimitState();
  const ip = "10.0.0.200";

  // Simulate attacker sending 50 requests with different fake token names
  // The IP burst limiter catches this regardless of token diversity
  for (let i = 0; i < 50; i++) {
    checkIpBurst(ip);
  }
  assertEquals(checkIpBurst(ip).allowed, false);
});
