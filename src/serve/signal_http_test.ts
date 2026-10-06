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
  handleSignalHttpRequest,
  matchSignalRoute,
  MAX_SIGNAL_BODY_BYTES,
  type SignalHttpDeps,
} from "./signal_http.ts";
import type { ConnectionContext } from "./handlers/shared.ts";
import { resetRateLimitState } from "./rate_limiter.ts";

const WAIT_ID = "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90";

/**
 * Deps whose context has no repository: reaching delivery throws, so a test
 * that gets a response proves the request was answered before it.
 */
function deps(
  mode: "token" | "none" = "token",
  calls: string[] = [],
): SignalHttpDeps {
  return {
    ctx: { authConfig: { mode } } as unknown as ConnectionContext,
    authenticate: (token) => {
      calls.push(token);
      return Promise.resolve(
        token === "good.secret"
          ? {
            ok: true as const,
            principalId: "user:caller",
            collectives: [],
            groups: [],
            tokenName: "good",
            tokenCreatedAt: "2026-01-01T00:00:00.000Z",
          }
          : {
            ok: false as const,
            error: "no",
            reason: "secret-mismatch" as const,
          },
      );
    },
  };
}

function request(
  options: { token?: string; body?: string } = {},
): Request {
  return new Request(`http://serve.test/api/v1/signal/${WAIT_ID}`, {
    method: "POST",
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    body: options.body ?? JSON.stringify({ payload: { verdict: "ship" } }),
  });
}

Deno.test("matchSignalRoute: matches only the signal path with a UUID, lower-cased", () => {
  assertEquals(
    matchSignalRoute(`/api/v1/signal/${WAIT_ID.toUpperCase()}`),
    WAIT_ID,
  );
  // Any UUID, whatever its version digits, as the WebSocket request accepts.
  assertEquals(
    matchSignalRoute("/api/v1/signal/00000000-0000-0000-0000-000000000001"),
    "00000000-0000-0000-0000-000000000001",
  );
  for (
    const path of [
      "/api/v1/signal",
      "/api/v1/signal/",
      "/api/v1/signal/not-a-uuid",
      "/api/v1/signal/------------------------------------",
      "/api/v1/signal/6f1c0a523f0e4c4b9d532f6a7c1e8b90aaaa",
      `/api/v1/signal/${WAIT_ID}/extra`,
      `/api/v1/signal/${WAIT_ID}%2F..`,
      `/api/v1/signals/${WAIT_ID}`,
      `/api/v1/cancel/workflow-run/${WAIT_ID}`,
    ]
  ) {
    assertEquals(matchSignalRoute(path), undefined, path);
  }
});

Deno.test("handleSignalHttpRequest: without a token nothing is authenticated or read", async () => {
  resetRateLimitState();
  const calls: string[] = [];
  const response = await handleSignalHttpRequest(
    request(),
    WAIT_ID,
    "203.0.113.1",
    deps("token", calls),
  );
  assertEquals(response.status, 401);
  assertEquals(await response.text(), "Unauthorized: token required");
  assertEquals(calls, []);
});

Deno.test("handleSignalHttpRequest: a token that does not authenticate is refused before the body is read", async () => {
  resetRateLimitState();
  const response = await handleSignalHttpRequest(
    request({ token: "bad.secret", body: "{not json" }),
    WAIT_ID,
    "203.0.113.2",
    deps(),
  );
  assertEquals(response.status, 401);
  await response.body?.cancel();
});

Deno.test("handleSignalHttpRequest: repeated bad tokens are rate limited without authenticating again", async () => {
  resetRateLimitState();
  const calls: string[] = [];
  const d = deps("token", calls);
  let status = 0;
  let attempts = 0;
  while (status !== 429 && attempts < 1000) {
    const response = await handleSignalHttpRequest(
      request({ token: "bad.secret" }),
      WAIT_ID,
      "203.0.113.3",
      d,
    );
    status = response.status;
    await response.body?.cancel();
    attempts++;
  }
  assertEquals(status, 429);
  // The request that was limited did not reach the authenticator.
  assertEquals(calls.length, attempts - 1);
  resetRateLimitState();
});

Deno.test("handleSignalHttpRequest: a malformed or oversized body is refused before delivery", async () => {
  resetRateLimitState();
  const cases: Array<[string, number]> = [
    ["{not json", 400],
    ["[]", 400],
    ['"text"', 400],
    [JSON.stringify({ verdict: "ship" }), 400],
    [
      JSON.stringify({ payload: { note: "x".repeat(MAX_SIGNAL_BODY_BYTES) } }),
      413,
    ],
  ];
  for (const [body, expected] of cases) {
    const response = await handleSignalHttpRequest(
      request({ token: "good.secret", body }),
      WAIT_ID,
      "203.0.113.4",
      deps(),
    );
    assertEquals(response.status, expected, body.slice(0, 40));
    await response.body?.cancel();
  }
});
