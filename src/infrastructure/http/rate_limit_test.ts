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

import { assertEquals, assertRejects } from "@std/assert";
import { assertStringIncludes } from "@std/assert/string-includes";
import {
  abortableSleep,
  fetchWithRateLimitRetry,
  hasCredential,
  MAX_RATE_LIMIT_RETRIES,
  parseRateLimitScope,
  parseRetryAfter,
  rateLimitError,
  readRateLimit,
} from "./rate_limit.ts";

Deno.test("parseRetryAfter: returns undefined for null", () => {
  assertEquals(parseRetryAfter(null), undefined);
});

Deno.test("parseRetryAfter: returns undefined for empty string", () => {
  assertEquals(parseRetryAfter(""), undefined);
  assertEquals(parseRetryAfter("   "), undefined);
});

Deno.test("parseRetryAfter: parses integer delta-seconds", () => {
  assertEquals(parseRetryAfter("120"), 120);
  assertEquals(parseRetryAfter("0"), 0);
  assertEquals(parseRetryAfter("  60  "), 60);
});

Deno.test("parseRetryAfter: rounds up fractional delta-seconds", () => {
  assertEquals(parseRetryAfter("1.2"), 2);
  assertEquals(parseRetryAfter("0.1"), 1);
});

Deno.test("parseRetryAfter: parses HTTP-date in the future", () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const seconds = parseRetryAfter(future);
  // Allow tiny clock drift between Date.now() calls.
  assertEquals(seconds !== undefined && seconds >= 59 && seconds <= 61, true);
});

Deno.test("parseRetryAfter: clamps HTTP-date in the past to 0", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  assertEquals(parseRetryAfter(past), 0);
});

Deno.test("parseRetryAfter: returns undefined for unparseable values", () => {
  assertEquals(parseRetryAfter("soon"), undefined);
  assertEquals(parseRetryAfter("-1"), undefined);
});

function tooManyRequests(
  headers: Record<string, string> = {},
  body = "rate limited",
): Response {
  return new Response(body, { status: 429, headers });
}

/** Serves `responses` in order, recording how many were requested. */
function scriptedAttempts(responses: (() => Response)[]) {
  let calls = 0;
  return {
    attempt: () => Promise.resolve(responses[calls++]()),
    get calls() {
      return calls;
    },
  };
}

function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

Deno.test("parseRateLimitScope: accepts the three swamp-club scopes", () => {
  assertEquals(parseRateLimitScope("anonymous"), "anonymous");
  assertEquals(parseRateLimitScope("principal"), "principal");
  assertEquals(parseRateLimitScope(" Global "), "global");
});

Deno.test("parseRateLimitScope: returns undefined for unknown or non-string values", () => {
  assertEquals(parseRateLimitScope(null), undefined);
  assertEquals(parseRateLimitScope("tenant"), undefined);
  assertEquals(parseRateLimitScope(42), undefined);
});

Deno.test("readRateLimit: prefers the X-RateLimit-Scope header", async () => {
  const info = await readRateLimit(
    tooManyRequests(
      { "retry-after": "15", "x-ratelimit-scope": "principal" },
      JSON.stringify({ scope: "global" }),
    ),
  );
  assertEquals(info, { retryAfterSeconds: 15, scope: "principal" });
});

Deno.test("readRateLimit: falls back to the body scope field", async () => {
  const info = await readRateLimit(
    tooManyRequests(
      {},
      JSON.stringify({ error: "Rate limit exceeded", scope: "anonymous" }),
    ),
  );
  assertEquals(info, { retryAfterSeconds: undefined, scope: "anonymous" });
});

Deno.test("readRateLimit: leaves scope undefined for a non-JSON body", async () => {
  const info = await readRateLimit(tooManyRequests({ "retry-after": "5" }));
  assertEquals(info, { retryAfterSeconds: 5, scope: undefined });
});

Deno.test("readRateLimit: ignores a body larger than the read limit", async () => {
  const body = JSON.stringify({ scope: "global", pad: "x".repeat(10_000) });
  const info = await readRateLimit(tooManyRequests({}, body));
  assertEquals(info.scope, undefined);
});

Deno.test("hasCredential: detects x-api-key and Authorization headers", () => {
  assertEquals(hasCredential(new Headers({ "x-api-key": "k" })), true);
  assertEquals(
    hasCredential(new Headers({ Authorization: "Bearer t" })),
    true,
  );
  assertEquals(hasCredential(new Headers({ "User-Agent": "swamp" })), false);
});

Deno.test("rateLimitError: anonymous scope includes the sign-in hint", () => {
  const err = rateLimitError({
    retryAfterSeconds: 42,
    scope: "anonymous",
    credentialed: false,
  });
  assertStringIncludes(err.message, "Rate limit exceeded");
  assertStringIncludes(err.message, "Retry in 42s");
  assertStringIncludes(err.message, "swamp auth login");
});

Deno.test("rateLimitError: principal scope names the shared credential and omits the sign-in hint", () => {
  const err = rateLimitError({
    retryAfterSeconds: 15,
    scope: "principal",
    credentialed: true,
  });
  assertStringIncludes(err.message, "this API key or login");
  assertStringIncludes(err.message, "Retry in 15s");
  assertEquals(err.message.includes("swamp auth login"), false);
});

Deno.test("rateLimitError: global scope reports a busy server without the sign-in hint", () => {
  const err = rateLimitError({
    retryAfterSeconds: 3,
    scope: "global",
    credentialed: false,
  });
  assertStringIncludes(err.message, "too many requests");
  assertStringIncludes(err.message, "Retry in 3s");
  assertEquals(err.message.includes("swamp auth login"), false);
});

Deno.test("rateLimitError: unknown scope shows the sign-in hint only without a credential", () => {
  const anonymous = rateLimitError({ credentialed: false });
  assertStringIncludes(anonymous.message, "swamp auth login");
  assertEquals(anonymous.message.includes("Retry in"), false);

  const signedIn = rateLimitError({ retryAfterSeconds: 9, credentialed: true });
  assertStringIncludes(signedIn.message, "Retry in 9s");
  assertEquals(signedIn.message.includes("swamp auth login"), false);
});

Deno.test("fetchWithRateLimitRetry: returns a non-429 response untouched", async () => {
  const script = scriptedAttempts([() => new Response("ok")]);
  const res = await fetchWithRateLimitRetry(script.attempt);
  assertEquals(await res.text(), "ok");
  assertEquals(script.calls, 1);
});

Deno.test("fetchWithRateLimitRetry: retries a GET after Retry-After plus jitter", async () => {
  const { delays, sleep } = recordingSleep();
  const script = scriptedAttempts([
    () =>
      tooManyRequests({
        "retry-after": "15",
        "x-ratelimit-scope": "principal",
      }),
    () => new Response("ok"),
  ]);
  const res = await fetchWithRateLimitRetry(script.attempt, {
    method: "GET",
    sleep,
    random: () => 0.5,
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(script.calls, 2);
  assertEquals(delays, [15_500]);
});

Deno.test("fetchWithRateLimitRetry: keeps each wait within [Retry-After, Retry-After + 1s)", async () => {
  const { delays, sleep } = recordingSleep();
  const script = scriptedAttempts([
    () => tooManyRequests({ "retry-after": "2" }),
    () => new Response("ok"),
  ]);
  const res = await fetchWithRateLimitRetry(script.attempt, { sleep });
  await res.body?.cancel();
  assertEquals(delays.length, 1);
  assertEquals(delays[0] >= 2000 && delays[0] < 3000, true);
});

Deno.test("fetchWithRateLimitRetry: gives up after the maximum retries and returns the 429", async () => {
  const { delays, sleep } = recordingSleep();
  const script = scriptedAttempts(
    Array.from(
      { length: MAX_RATE_LIMIT_RETRIES + 1 },
      () => () => tooManyRequests({ "retry-after": "1" }),
    ),
  );
  const res = await fetchWithRateLimitRetry(script.attempt, { sleep });
  assertEquals(res.status, 429);
  await res.body?.cancel();
  assertEquals(script.calls, MAX_RATE_LIMIT_RETRIES + 1);
  assertEquals(delays.length, MAX_RATE_LIMIT_RETRIES);
});

Deno.test("fetchWithRateLimitRetry: does not retry a Retry-After above the cap", async () => {
  const { delays, sleep } = recordingSleep();
  const script = scriptedAttempts([
    () => tooManyRequests({ "retry-after": "120" }),
  ]);
  const res = await fetchWithRateLimitRetry(script.attempt, { sleep });
  assertEquals(res.status, 429);
  await res.body?.cancel();
  assertEquals(script.calls, 1);
  assertEquals(delays, []);
});

Deno.test("fetchWithRateLimitRetry: does not retry a 429 without Retry-After", async () => {
  const { sleep } = recordingSleep();
  const script = scriptedAttempts([() => tooManyRequests()]);
  const res = await fetchWithRateLimitRetry(script.attempt, { sleep });
  assertEquals(res.status, 429);
  await res.body?.cancel();
  assertEquals(script.calls, 1);
});

Deno.test("fetchWithRateLimitRetry: never retries non-idempotent methods", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const { sleep } = recordingSleep();
    const script = scriptedAttempts([
      () => tooManyRequests({ "retry-after": "1" }),
    ]);
    const res = await fetchWithRateLimitRetry(script.attempt, {
      method,
      sleep,
    });
    assertEquals(res.status, 429);
    await res.body?.cancel();
    assertEquals(script.calls, 1, method);
  }
});

Deno.test("fetchWithRateLimitRetry: an aborted signal cancels the wait", async () => {
  const controller = new AbortController();
  const script = scriptedAttempts([
    () => {
      controller.abort();
      return tooManyRequests({ "retry-after": "30" });
    },
  ]);
  await assertRejects(
    () =>
      fetchWithRateLimitRetry(script.attempt, { signal: controller.signal }),
    DOMException,
  );
  assertEquals(script.calls, 1);
});

Deno.test("abortableSleep: resolves after the delay", async () => {
  await abortableSleep(1);
});

Deno.test("abortableSleep: rejects with the abort reason and clears its timer", async () => {
  const controller = new AbortController();
  const pending = abortableSleep(60_000, controller.signal);
  controller.abort(new Error("stop"));
  await assertRejects(() => pending, Error, "stop");
});
