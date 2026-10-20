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

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { assertStringIncludes } from "@std/assert/string-includes";
import { UserError } from "../../domain/errors.ts";
import {
  describeRequestTarget,
  fetchWithTransientRetry,
  formatElapsed,
  formatRetryNotice,
  MAX_TRANSIENT_RETRIES,
  type RetryNotice,
  TransientRequestError,
  type TransientRetryOptions,
} from "./transient_retry.ts";

type Step = Response | Error | (() => Response | Error);

/**
 * A fake clock, sleep and attempt script. Sleeping advances the clock, so
 * budgets are exercised without waiting.
 */
function harness(
  steps: Step[],
  overrides: Partial<TransientRetryOptions> = {},
) {
  let clock = 0;
  const delays: number[] = [];
  const notices: RetryNotice[] = [];
  const signals: AbortSignal[] = [];
  let calls = 0;
  const attempt = (signal: AbortSignal) => {
    signals.push(signal);
    const step = steps[Math.min(calls++, steps.length - 1)];
    const value = typeof step === "function" ? step() : step;
    return value instanceof Error
      ? Promise.reject(value)
      : Promise.resolve(value);
  };
  const options: TransientRetryOptions = {
    target: "/api/v1/extensions/x",
    sleep: (ms) => {
      delays.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    random: () => 0,
    now: () => clock,
    onRetry: (notice) => notices.push(notice),
    ...overrides,
  };
  return {
    run: () => fetchWithTransientRetry(attempt, options),
    delays,
    notices,
    signals,
    get calls() {
      return calls;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

const timeoutError = () =>
  new DOMException("Signal timed out.", "TimeoutError");
const status = (code: number, headers: Record<string, string> = {}) => () =>
  new Response("body", { status: code, headers });

Deno.test("fetchWithTransientRetry: returns a success untouched after one attempt", async () => {
  const h = harness([new Response("ok")]);
  const { response, outcome } = await h.run();
  assertEquals(await response.text(), "ok");
  assertEquals(outcome.attempts, 1);
  assertEquals(h.notices.length, 0);
});

Deno.test("fetchWithTransientRetry: retries a timeout and then succeeds", async () => {
  const h = harness([timeoutError(), () => new Response("ok")]);
  const { response, outcome } = await h.run();
  assertEquals(await response.text(), "ok");
  assertEquals(outcome.attempts, 2);
  assertEquals(h.delays, [1000]);
  assertEquals(h.notices[0].reason, { kind: "timeout", afterMs: 15_000 });
  assertEquals(h.notices[0].retry, 1);
});

Deno.test("fetchWithTransientRetry: retries a connection failure and then succeeds", async () => {
  const h = harness([
    new TypeError("error sending request: connection reset"),
    () => new Response("ok"),
  ]);
  const { outcome } = await h.run();
  assertEquals(outcome.attempts, 2);
  assertEquals(h.notices[0].reason, {
    kind: "connection",
    message: "error sending request: connection reset",
  });
});

Deno.test("fetchWithTransientRetry: retries 502, 503 and 504", async () => {
  for (const code of [502, 503, 504]) {
    const h = harness([status(code), () => new Response("ok")]);
    const { response } = await h.run();
    assertEquals(response.status, 200);
    assertEquals(h.notices[0].reason, { kind: "status", status: code });
  }
});

Deno.test("fetchWithTransientRetry: a 503 waits out its Retry-After", async () => {
  const h = harness([
    status(503, { "retry-after": "7" }),
    () => new Response("ok"),
  ]);
  await h.run();
  assertEquals(h.delays, [7000]);
});

Deno.test("fetchWithTransientRetry: never retries other statuses", async () => {
  for (const code of [400, 401, 403, 404, 409, 422, 500]) {
    const h = harness([status(code)]);
    const { response, outcome } = await h.run();
    assertEquals(response.status, code);
    assertEquals(outcome.attempts, 1);
  }
});

Deno.test("fetchWithTransientRetry: gives up after the initial attempt plus five retries with exponential backoff", async () => {
  const h = harness([timeoutError()]);
  const error = await assertRejects(() => h.run(), TransientRequestError);
  assertEquals(error.kind, "timeout");
  assertEquals(error.outcome.attempts, 1 + MAX_TRANSIENT_RETRIES);
  assertEquals(h.delays, [1000, 2000, 4000, 8000, 16000]);
  assertEquals(h.notices.map((n) => n.retry), [1, 2, 3, 4, 5]);
});

Deno.test("fetchWithTransientRetry: returns the last 5xx once retries are spent", async () => {
  const h = harness([status(503)]);
  const { response, outcome } = await h.run();
  assertEquals(response.status, 503);
  assertEquals(outcome.attempts, 6);
});

Deno.test("fetchWithTransientRetry: adds at most a quarter of the wait as jitter", async () => {
  const h = harness([timeoutError(), () => new Response("ok")], {
    random: () => 0.999,
  });
  await h.run();
  assertEquals(h.delays, [1249]);
});

Deno.test("fetchWithTransientRetry: does not take a retry whose wait would end past the budget", async () => {
  const h = harness([timeoutError()], { budgetMs: 5000 });
  const error = await assertRejects(() => h.run(), TransientRequestError);
  // 1s and 2s fit; the 4s wait would end at 7s.
  assertEquals(h.delays, [1000, 2000]);
  assertEquals(error.outcome.attempts, 3);
});

Deno.test("fetchWithTransientRetry: clips the attempt timeout to the remaining budget", async () => {
  let advance = (_ms: number) => {};
  const h = harness([
    () => {
      // The first attempt spends its whole 15s before timing out.
      advance(15_000);
      return timeoutError();
    },
    timeoutError(),
  ], { budgetMs: 20_000, attemptTimeoutMs: 15_000 });
  advance = h.advance;
  await assertRejects(() => h.run(), TransientRequestError);
  // Attempt 2 starts at 16s, with 4s of the budget left.
  assertEquals(h.notices[0].reason, { kind: "timeout", afterMs: 15_000 });
  assertEquals(h.notices[1].reason, { kind: "timeout", afterMs: 4_000 });
});

Deno.test("fetchWithTransientRetry: retries a 429 with a short Retry-After at most twice", async () => {
  const h = harness([
    status(429, { "retry-after": "3", "x-ratelimit-scope": "principal" }),
  ]);
  const { response, outcome } = await h.run();
  assertEquals(response.status, 429);
  assertEquals(outcome.attempts, 3);
  assertEquals(h.delays, [3000, 3000]);
  assertEquals(h.notices[0].reason, { kind: "rate_limit", scope: "principal" });
});

Deno.test("fetchWithTransientRetry: rate-limit and transient retries share one ceiling", async () => {
  const h = harness([
    status(429, { "retry-after": "1" }),
    status(429, { "retry-after": "1" }),
    timeoutError(),
  ]);
  const error = await assertRejects(() => h.run(), TransientRequestError);
  assertEquals(error.outcome.attempts, 6);
  assertEquals(h.notices.length, 5);
});

Deno.test("fetchWithTransientRetry: does not retry a 429 above the cap or without Retry-After", async () => {
  for (
    const headers of [{ "retry-after": "61" }, {}] as Record<string, string>[]
  ) {
    const h = harness([status(429, headers)]);
    const { outcome } = await h.run();
    assertEquals(outcome.attempts, 1);
  }
});

Deno.test("fetchWithTransientRetry: never retries writes", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const h = harness([new TypeError("connection reset")], { method });
    const error = await assertRejects(() => h.run(), TransientRequestError);
    assertEquals(error.outcome.attempts, 1);
    const s = harness([status(503)], { method });
    assertEquals((await s.run()).outcome.attempts, 1);
  }
});

Deno.test("fetchWithTransientRetry: rethrows a UserError from the attempt untouched", async () => {
  const h = harness([new UserError("archive too large")]);
  await assertRejects(() => h.run(), UserError, "archive too large");
  assertEquals(h.calls, 1);
});

Deno.test("fetchWithTransientRetry: a caller abort during a request is not retried", async () => {
  const controller = new AbortController();
  const h = harness([
    () => {
      controller.abort();
      return new DOMException("aborted", "AbortError");
    },
  ], { signal: controller.signal });
  const error = await assertRejects(() => h.run(), TransientRequestError);
  assertEquals(error.kind, "aborted");
  assertEquals(h.calls, 1);
});

Deno.test("fetchWithTransientRetry: a caller timeout is a deadline, not a retryable timeout", async () => {
  const controller = new AbortController();
  const h = harness([
    () => {
      controller.abort(timeoutError());
      return timeoutError();
    },
  ], { signal: controller.signal });
  const error = await assertRejects(() => h.run(), TransientRequestError);
  assertEquals(error.kind, "deadline");
  assertEquals(h.calls, 1);
});

Deno.test("fetchWithTransientRetry: a caller abort during the backoff ends the wait", async () => {
  const controller = new AbortController();
  const h = harness([timeoutError()], {
    signal: controller.signal,
    sleep: (_ms, signal) => {
      controller.abort(timeoutError());
      return Promise.reject(signal?.reason);
    },
  });
  const error = await assertRejects(() => h.run(), TransientRequestError);
  assertEquals(error.kind, "deadline");
  assertEquals(h.calls, 1);
});

Deno.test("fetchWithTransientRetry: each attempt's signal carries the caller's signal", async () => {
  const controller = new AbortController();
  const h = harness([new Response("ok")], { signal: controller.signal });
  await h.run();
  controller.abort();
  assertEquals(h.signals[0].aborted, true);
});

Deno.test("fetchWithTransientRetry: the default notice is logged, not thrown", async () => {
  const h = harness([timeoutError(), () => new Response("ok")], {
    onRetry: undefined,
  });
  const { outcome } = await h.run();
  assertEquals(outcome.attempts, 2);
});

Deno.test("formatRetryNotice: names the service, request, reason, wait and counter", () => {
  const line = formatRetryNotice({
    service: "swamp-club registry",
    method: "GET",
    target: "/api/v1/extensions/%40swamp%2Fgcs-datastore",
    reason: { kind: "timeout", afterMs: 15_000 },
    waitMs: 2400,
    retry: 2,
    maxRetries: 5,
  });
  assertEquals(
    line,
    "swamp-club registry: GET /api/v1/extensions/%40swamp%2Fgcs-datastore timed out after 15s · retrying in 2s (retry 2/5)",
  );
});

Deno.test("formatRetryNotice: describes status, connection and rate-limit reasons", () => {
  const base = {
    service: "s",
    method: "GET",
    target: "/p",
    waitMs: 500,
    retry: 1,
    maxRetries: 5,
  };
  assertStringIncludes(
    formatRetryNotice({ ...base, reason: { kind: "status", status: 503 } }),
    "HTTP 503 Service Unavailable · retrying in 1s (retry 1/5)",
  );
  assertStringIncludes(
    formatRetryNotice({
      ...base,
      reason: { kind: "connection", message: "connection reset" },
    }),
    "connection failed (connection reset)",
  );
  assertStringIncludes(
    formatRetryNotice({
      ...base,
      reason: { kind: "rate_limit", scope: "global" },
    }),
    "rate limited (scope global)",
  );
});

Deno.test("describeRequestTarget: drops the query string, fragment and userinfo", () => {
  assertEquals(
    describeRequestTarget(
      "https://user:pw@storage.example.com/bucket/a.tgz?X-Goog-Signature=abc#x",
    ),
    "https://storage.example.com/bucket/a.tgz",
  );
  assertEquals(
    describeRequestTarget("/api/v1/extensions/search?q=secret"),
    "/api/v1/extensions/search",
  );
});

Deno.test("formatElapsed: renders milliseconds, seconds and minutes", () => {
  assertEquals(formatElapsed(850), "850ms");
  assertEquals(formatElapsed(12_400), "12s");
  assertEquals(formatElapsed(107_000), "1m 47s");
});

Deno.test("TransientRequestError: keeps the cause and outcome", () => {
  const cause = new TypeError("reset");
  const error = new TransientRequestError(
    "connection",
    { method: "GET", target: "/p", attempts: 6, elapsedMs: 1 },
    15_000,
    { cause },
  );
  assertInstanceOf(error, Error);
  assertEquals(error.cause, cause);
  assertEquals(error.outcome.attempts, 6);
});
