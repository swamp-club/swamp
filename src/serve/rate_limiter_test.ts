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

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  checkFailedAttempts,
  checkIpBurst,
  checkPrincipalRate,
  limitDashboardSessionGuesses,
  limitFailedAttempts,
  MAX_PENDING_ATTEMPTS,
  MAX_PRINCIPAL_RATE_BUCKETS,
  pendingAttemptCount,
  PRINCIPAL_RATE_BURST,
  PRINCIPAL_RATE_PER_MINUTE,
  principalRateBucketCount,
  rateLimitKey,
  recordFailedAttempt,
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

Deno.test("recordFailedAttempt: allows up to 5 failures for a key", () => {
  resetRateLimitState();
  const key = "token:test-allows-five";
  for (let i = 0; i < 5; i++) {
    assertEquals(recordFailedAttempt(key).allowed, true);
  }
});

Deno.test("recordFailedAttempt: refuses the 6th failure for same key", () => {
  resetRateLimitState();
  const key = "token:test-blocks-sixth";
  for (let i = 0; i < 5; i++) {
    recordFailedAttempt(key);
  }
  const result = recordFailedAttempt(key);
  assertEquals(result.allowed, false);
  assert(!result.allowed && result.retryAfterSeconds > 0);
});

Deno.test("checkFailedAttempts: never counts, however often it is asked", () => {
  resetRateLimitState();
  const key = "token:peek-only";
  for (let i = 0; i < 100; i++) {
    assertEquals(checkFailedAttempts(key).allowed, true);
  }
  recordFailedAttempt(key);
  for (let i = 0; i < 100; i++) {
    assertEquals(checkFailedAttempts(key).allowed, true);
  }
});

Deno.test("checkFailedAttempts: refuses a key holding 5 failures", () => {
  resetRateLimitState();
  const key = "token:five-failures";
  for (let i = 0; i < 4; i++) {
    recordFailedAttempt(key);
  }
  assertEquals(checkFailedAttempts(key).allowed, true);
  recordFailedAttempt(key);
  const result = checkFailedAttempts(key);
  assertEquals(result.allowed, false);
  assert(!result.allowed && result.retryAfterSeconds > 0);
});

Deno.test("checkFailedAttempts: different token names are independent", () => {
  resetRateLimitState();
  for (let i = 0; i < 5; i++) {
    recordFailedAttempt("token:worker-a");
  }
  assertEquals(checkFailedAttempts("token:worker-a").allowed, false);
  assertEquals(checkFailedAttempts("token:worker-b").allowed, true);
});

Deno.test("checkFailedAttempts: IP-keyed fallback works like token keys", () => {
  resetRateLimitState();
  const ipKey = "ip:192.168.1.1";
  for (let i = 0; i < 5; i++) {
    recordFailedAttempt(ipKey);
  }
  assertEquals(checkFailedAttempts(ipKey).allowed, false);
});

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => open = resolve);
  return { opened, open };
}

const passed = { ok: true } as const;
const failed = { ok: false } as const;

Deno.test("limitFailedAttempts: concurrent attempts on one valid credential are all accepted", async () => {
  resetRateLimitState();
  const key = `token:${crypto.randomUUID()}`;
  const { opened, open } = gate();
  const attempts = Array.from(
    { length: 20 },
    () =>
      limitFailedAttempts(key, async () => {
        await opened;
        return passed;
      }),
  );
  open();
  for (const guarded of await Promise.all(attempts)) {
    assertEquals(guarded.limited, false);
  }
  assertEquals(pendingAttemptCount(), 0);
});

Deno.test("limitFailedAttempts: 5 failures lock the key and a locked key is not tried", async () => {
  resetRateLimitState();
  const key = `token:${crypto.randomUUID()}`;
  let calls = 0;
  const attempt = () => {
    calls++;
    return Promise.resolve(failed);
  };
  for (let i = 0; i < 5; i++) {
    const guarded = await limitFailedAttempts(key, attempt);
    assertEquals(guarded.limited, false);
  }
  const locked = await limitFailedAttempts(key, attempt);
  assertEquals(locked.limited, true);
  assert(locked.limited && locked.retryAfterSeconds > 0);
  assertEquals(calls, 5);
});

Deno.test("limitFailedAttempts: a success clears earlier failures", async () => {
  resetRateLimitState();
  const key = `token:${crypto.randomUUID()}`;
  for (let i = 0; i < 4; i++) {
    await limitFailedAttempts(key, () => Promise.resolve(failed));
  }
  await limitFailedAttempts(key, () => Promise.resolve(passed));
  for (let i = 0; i < 4; i++) {
    await limitFailedAttempts(key, () => Promise.resolve(failed));
  }
  assertEquals(checkFailedAttempts(key).allowed, true);
});

Deno.test("limitFailedAttempts: attempts in flight past the cap are refused untried until one settles", async () => {
  resetRateLimitState();
  const key = `token:${crypto.randomUUID()}`;
  const { opened, open } = gate();
  const held = Array.from(
    { length: MAX_PENDING_ATTEMPTS },
    () =>
      limitFailedAttempts(key, async () => {
        await opened;
        return passed;
      }),
  );
  let tried = false;
  const refused = await limitFailedAttempts(key, () => {
    tried = true;
    return Promise.resolve(passed);
  });
  assertEquals(refused, { limited: true, retryAfterSeconds: 1 });
  assertEquals(tried, false);
  assertEquals(
    (await limitFailedAttempts(
      `token:${crypto.randomUUID()}`,
      () => Promise.resolve(passed),
    )).limited,
    false,
  );
  open();
  await Promise.all(held);
  assertEquals(
    (await limitFailedAttempts(key, () => Promise.resolve(passed))).limited,
    false,
  );
  assertEquals(pendingAttemptCount(), 0);
});

Deno.test("limitFailedAttempts: an attempt that throws records no failure and releases its slot", async () => {
  resetRateLimitState();
  const key = `token:${crypto.randomUUID()}`;
  for (let i = 0; i < 10; i++) {
    await assertRejects(
      () => limitFailedAttempts(key, () => Promise.reject(new Error("boom"))),
      Error,
      "boom",
    );
  }
  assertEquals(checkFailedAttempts(key).allowed, true);
  assertEquals(pendingAttemptCount(), 0);
});

function guessIp(): string {
  return `guess-${crypto.randomUUID()}`;
}

Deno.test("limitDashboardSessionGuesses: successes never count", async () => {
  const ip = guessIp();
  for (let i = 0; i < 120; i++) {
    const guarded = await limitDashboardSessionGuesses(
      ip,
      () => Promise.resolve(passed),
    );
    assertEquals(guarded.limited, false);
  }
});

Deno.test("limitDashboardSessionGuesses: 50 failures lock the IP and a locked IP is not tried", async () => {
  const ip = guessIp();
  let calls = 0;
  const attempt = () => {
    calls++;
    return Promise.resolve(failed);
  };
  for (let i = 0; i < 50; i++) {
    assertEquals(
      (await limitDashboardSessionGuesses(ip, attempt)).limited,
      false,
    );
  }
  const locked = await limitDashboardSessionGuesses(ip, attempt);
  assert(locked.limited && locked.retryAfterSeconds > 0);
  assertEquals(calls, 50);
  assertEquals(
    (await limitDashboardSessionGuesses(
      guessIp(),
      () => Promise.resolve(passed),
    )).limited,
    false,
  );
});

Deno.test("limitDashboardSessionGuesses: a success does not clear earlier failures", async () => {
  const ip = guessIp();
  for (let i = 0; i < 49; i++) {
    await limitDashboardSessionGuesses(ip, () => Promise.resolve(failed));
  }
  await limitDashboardSessionGuesses(ip, () => Promise.resolve(passed));
  await limitDashboardSessionGuesses(ip, () => Promise.resolve(failed));
  assertEquals(
    (await limitDashboardSessionGuesses(ip, () => Promise.resolve(passed)))
      .limited,
    true,
  );
});

Deno.test("limitDashboardSessionGuesses: guesses in flight past the cap are refused untried until one settles", async () => {
  const ip = guessIp();
  const { opened, open } = gate();
  const held = Array.from(
    { length: 50 },
    () =>
      limitDashboardSessionGuesses(ip, async () => {
        await opened;
        return passed;
      }),
  );
  let tried = false;
  const refused = await limitDashboardSessionGuesses(ip, () => {
    tried = true;
    return Promise.resolve(passed);
  });
  assertEquals(refused, { limited: true, retryAfterSeconds: 1 });
  assertEquals(tried, false);
  open();
  await Promise.all(held);
  assertEquals(
    (await limitDashboardSessionGuesses(ip, () => Promise.resolve(passed)))
      .limited,
    false,
  );
});

Deno.test("limitDashboardSessionGuesses: an attempt that throws records no guess and releases its slot", async () => {
  const ip = guessIp();
  for (let i = 0; i < 60; i++) {
    await assertRejects(
      () =>
        limitDashboardSessionGuesses(
          ip,
          () => Promise.reject(new Error("store down")),
        ),
      Error,
      "store down",
    );
  }
  assertEquals(
    (await limitDashboardSessionGuesses(ip, () => Promise.resolve(passed)))
      .limited,
    false,
  );
});

Deno.test("limitDashboardSessionGuesses: shares nothing with checkIpBurst", async () => {
  const fullBurst = guessIp();
  for (let i = 0; i < 51; i++) checkIpBurst(fullBurst);
  assertEquals(checkIpBurst(fullBurst).allowed, false);
  assertEquals(
    (await limitDashboardSessionGuesses(
      fullBurst,
      () => Promise.resolve(passed),
    )).limited,
    false,
  );

  const fullGuesses = guessIp();
  for (let i = 0; i < 50; i++) {
    await limitDashboardSessionGuesses(
      fullGuesses,
      () => Promise.resolve(failed),
    );
  }
  assertEquals(checkIpBurst(fullGuesses).allowed, true);
});

Deno.test("limitDashboardSessionGuesses: is cleared by resetRateLimitState", async () => {
  const ip = guessIp();
  for (let i = 0; i < 50; i++) {
    await limitDashboardSessionGuesses(ip, () => Promise.resolve(failed));
  }
  resetRateLimitState();
  assertEquals(
    (await limitDashboardSessionGuesses(ip, () => Promise.resolve(passed)))
      .limited,
    false,
  );
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
  assertEquals(checkFailedAttempts("token:shared").allowed, true);
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
