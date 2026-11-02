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

import { assertEquals, assertInstanceOf } from "@std/assert";
import {
  ANONYMOUS_PRINCIPAL,
  authenticateHttpCaller,
  bearerToken,
  type HttpCaller,
} from "./http_caller_auth.ts";
import type { ServerTokenAuthResult } from "./token_auth.ts";

function request(authorization?: string): Request {
  return new Request("http://serve.test/api/v1/request", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

const validToken: ServerTokenAuthResult = {
  ok: true,
  principalId: "user:adam",
  collectives: ["acme"],
  groups: ["ops"],
  tokenName: "laptop",
  tokenCreatedAt: "2026-11-01T00:00:00.000Z",
};

function uniqueIp(): string {
  return `ip-${crypto.randomUUID()}`;
}

Deno.test("authenticateHttpCaller: auth mode none gives the anonymous caller without asking for a token", async () => {
  let asked = false;
  const caller = await authenticateHttpCaller(request(), "10.0.0.1", {
    authMode: "none",
    authenticate: () => {
      asked = true;
      return Promise.resolve(validToken);
    },
  });

  assertEquals(asked, false);
  assertEquals((caller as HttpCaller).principal, ANONYMOUS_PRINCIPAL);
  assertEquals((caller as HttpCaller).access.principal, null);
  assertEquals((caller as HttpCaller).token, undefined);
});

Deno.test("authenticateHttpCaller: a request without a bearer token is refused with 401", async () => {
  const response = await authenticateHttpCaller(
    request("Basic dXNlcjpwYXNz"),
    uniqueIp(),
    {
      authMode: "token",
      authenticate: () => Promise.resolve(validToken),
    },
  );

  assertInstanceOf(response, Response);
  assertEquals(response.status, 401);
  assertEquals((await response.json()).code, "unauthorized");
});

Deno.test("authenticateHttpCaller: a token the server rejects is refused with 401 naming the reason", async () => {
  const response = await authenticateHttpCaller(
    request(`Bearer ${crypto.randomUUID()}`),
    uniqueIp(),
    {
      authMode: "token",
      authenticate: () =>
        Promise.resolve({ ok: false, error: "gone", reason: "revoked" }),
    },
  );

  assertInstanceOf(response, Response);
  assertEquals(response.status, 401);
  assertEquals((await response.json()).message, "Unauthorized: revoked");
});

Deno.test("authenticateHttpCaller: a valid token gives its principal, memberships and token identity", async () => {
  const token = crypto.randomUUID();
  let presented = "";
  const sourceIp = uniqueIp();
  const caller = await authenticateHttpCaller(
    request(`Bearer ${token}`),
    sourceIp,
    {
      authMode: "token",
      authenticate: (value) => {
        presented = value;
        return Promise.resolve(validToken);
      },
    },
  );

  assertEquals(presented, token);
  const authenticated = caller as HttpCaller;
  assertEquals(authenticated.principal, "user:adam");
  assertEquals(authenticated.access.collectives, ["acme"]);
  assertEquals(authenticated.access.groups, ["ops"]);
  assertEquals(authenticated.access.sourceIp, sourceIp);
  assertEquals(authenticated.token, {
    name: "laptop",
    createdAt: "2026-11-01T00:00:00.000Z",
    principalId: "user:adam",
  });
});

Deno.test("bearerToken: reads only a non-empty Bearer credential, case-insensitively", () => {
  assertEquals(bearerToken(request("bearer abc")), "abc");
  assertEquals(bearerToken(request("Bearer ")), null);
  assertEquals(bearerToken(request("Token abc")), null);
  assertEquals(bearerToken(request()), null);
});

Deno.test("authenticateHttpCaller: repeated failures with one token are rate-limited with 429 and Retry-After", async () => {
  const token = `Bearer ${crypto.randomUUID()}`;
  const sourceIp = uniqueIp();
  const deps = {
    authMode: "token",
    authenticate: (): Promise<ServerTokenAuthResult> =>
      Promise.resolve({ ok: false, error: "bad", reason: "secret-mismatch" }),
  };
  let last: HttpCaller | Response | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    last = await authenticateHttpCaller(request(token), sourceIp, deps);
    if (last instanceof Response && last.status === 429) break;
  }

  assertInstanceOf(last, Response);
  assertEquals(last.status, 429);
  assertEquals(last.headers.get("Retry-After") !== null, true);
});
