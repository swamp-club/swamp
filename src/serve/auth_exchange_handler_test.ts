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

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { SignInGrant } from "../domain/access/sign_in_code.ts";
import { UserError } from "../domain/errors.ts";
import { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../domain/serve_audit/audit_sink.ts";
import {
  type AuthExchangeDeps,
  authInfoBody,
  exchangeTarget,
  handleAuthExchange,
} from "./auth_exchange_handler.ts";
import type { ExchangeMintInput } from "./device_auth_handler.ts";
import { resetRateLimitState } from "./rate_limiter.ts";
import type { SignInCodeRedeemOutcome } from "./sign_in_code_redeem_client.ts";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const GRANT: SignInGrant = {
  principal: "user:sub-alice",
  username: "alice",
  email: "alice@example.com",
  collectives: ["acme"],
  groups: ["ops"],
  expiresAt: "2026-11-20T12:00:00.000Z",
};

function collectingSink(): AuditSink & { events: AuditEvent[] } {
  const sink = {
    name: "test-collector",
    durable: false,
    events: [] as AuditEvent[],
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.events.push(...events);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return sink;
}

interface Fixture {
  readonly deps: AuthExchangeDeps;
  readonly minted: ExchangeMintInput[];
  readonly redeemed: string[];
  readonly sink: AuditSink & { events: AuditEvent[] };
  readonly emitter: AuditEmitter;
}

function fixture(
  overrides: Partial<AuthExchangeDeps> = {},
  outcome: SignInCodeRedeemOutcome = { ok: true, grant: GRANT },
): Fixture {
  resetRateLimitState();
  const minted: ExchangeMintInput[] = [];
  const redeemed: string[] = [];
  const sink = collectingSink();
  const emitter = new AuditEmitter([sink]);
  return {
    minted,
    redeemed,
    sink,
    emitter,
    deps: {
      mode: "oauth",
      admissionLists: () => ({ allowedCollectives: [], allowedUsers: [] }),
      redeemer: {
        redeem: (code) => {
          redeemed.push(code);
          return Promise.resolve(outcome);
        },
      },
      mint: (input) => {
        minted.push(input);
        return Promise.resolve({
          token: "oauth-1234abcd.secret",
          expiresAt: input.notAfter,
        });
      },
      sourceIp: "203.0.113.7",
      now: () => NOW,
      auditEmitter: emitter,
      instanceId: "edge-dns-serve",
      ...overrides,
    },
  };
}

function exchange(body: unknown, method = "POST"): Request {
  return new Request("http://127.0.0.1/auth/exchange", {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "POST"
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  });
}

Deno.test("handleAuthExchange: mints a token for the principal the root vouched for, capped at the root token's expiry", async () => {
  const f = fixture();
  const response = await handleAuthExchange(
    exchange({ code: "swsc1.abc" }),
    f.deps,
  );
  assertEquals(response?.status, 200);
  assertEquals(response?.headers.get("cache-control"), "no-store");
  assertEquals(await response?.json(), {
    token: "oauth-1234abcd.secret",
    expiresAt: GRANT.expiresAt,
    principal: {
      id: "user:sub-alice",
      email: "alice@example.com",
      username: "alice",
      collectives: ["acme"],
      groups: ["ops"],
    },
  });
  assertEquals(f.redeemed, ["swsc1.abc"]);
  assertEquals(f.minted, [{
    principalId: "user:sub-alice",
    email: "alice@example.com",
    username: "alice",
    collectives: ["acme"],
    groups: ["ops"],
    notAfter: GRANT.expiresAt,
    oauthIdentity: true,
  }]);
});

Deno.test("handleAuthExchange: a token-mode workspace records no OAuth identity and needs no email", async () => {
  const f = fixture({ mode: "token" }, {
    ok: true,
    grant: { ...GRANT, principal: "user:alice", email: null, username: null },
  });
  const response = await handleAuthExchange(
    exchange({ code: "swsc1.abc" }),
    f.deps,
  );
  assertEquals(response?.status, 200);
  assertEquals(f.minted[0].oauthIdentity, false);
  assertEquals(f.minted[0].principalId, "user:alice");
});

Deno.test("handleAuthExchange: a principal its own lists do not admit gets no token, and the denial is audited here", async () => {
  const f = fixture({
    admissionLists: () => ({
      allowedCollectives: ["other-org"],
      allowedUsers: [],
    }),
  });
  const response = await handleAuthExchange(
    exchange({ code: "swsc1.abc" }),
    f.deps,
  );
  assertEquals(response?.status, 403);
  assertEquals(f.minted, []);
  await f.emitter.flush();
  const denied = f.sink.events.find((e) => e.action === "auth.exchange.denied");
  assertEquals(denied?.outcome, "denied");
  assertEquals(denied?.principalId, "sub-alice");
  assertEquals(denied?.instanceId, "edge-dns-serve");
});

Deno.test("handleAuthExchange: an OAuth workspace refuses a grant with no login email", async () => {
  const f = fixture({}, { ok: true, grant: { ...GRANT, email: null } });
  const response = await handleAuthExchange(
    exchange({ code: "swsc1.abc" }),
    f.deps,
  );
  assertEquals(response?.status, 403);
  assertEquals(f.minted, []);
});

Deno.test("handleAuthExchange: a refused code answers 401 and mints nothing", async () => {
  const f = fixture({}, { ok: false, reason: "refused" });
  const response = await handleAuthExchange(
    exchange({ code: "swsc1.abc" }),
    f.deps,
  );
  assertEquals(response?.status, 401);
  assertEquals(await response?.json(), { error: "code_refused" });
  assertEquals(f.minted, []);
});

Deno.test("handleAuthExchange: a root token already expired is refused", async () => {
  const f = fixture({}, {
    ok: true,
    grant: { ...GRANT, expiresAt: new Date(NOW).toISOString() },
  });
  const response = await handleAuthExchange(
    exchange({ code: "swsc1.abc" }),
    f.deps,
  );
  assertEquals(response?.status, 401);
  assertEquals(f.minted, []);
});

Deno.test("handleAuthExchange: an unreachable root answers 502", async () => {
  const f = fixture({}, {
    ok: false,
    reason: "unavailable",
    detail: "connection refused",
  });
  const response = await handleAuthExchange(
    exchange({ code: "swsc1.abc" }),
    f.deps,
  );
  assertEquals(response?.status, 502);
});

Deno.test("handleAuthExchange: refused codes from one address are limited; an unreachable root never counts", async () => {
  const f = fixture({}, { ok: false, reason: "refused" });
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const response = await handleAuthExchange(
      exchange({ code: `swsc1.${i}` }),
      f.deps,
    );
    statuses.push(response!.status);
  }
  assertEquals(statuses, [401, 401, 401, 401, 401, 429]);
  assertEquals(f.redeemed.length, 5);

  const down = fixture({}, { ok: false, reason: "unavailable", detail: "x" });
  for (let i = 0; i < 6; i++) {
    const response = await handleAuthExchange(
      exchange({ code: "swsc1.abc" }),
      down.deps,
    );
    assertEquals(response?.status, 502);
  }
});

Deno.test("handleAuthExchange: a serve that offers no exchange answers as not offered", async () => {
  const response = await handleAuthExchange(
    exchange({ code: "swsc1.abc" }),
    null,
  );
  assertEquals(response?.status, 404);
  assertEquals(await response?.json(), { error: "exchange_not_offered" });
});

Deno.test("handleAuthExchange: leaves other paths alone, and refuses bad methods and bodies", async () => {
  const f = fixture();
  assertEquals(
    await handleAuthExchange(new Request("http://127.0.0.1/auth/info"), f.deps),
    null,
  );
  assertEquals(
    (await handleAuthExchange(exchange(null, "GET"), f.deps))?.status,
    405,
  );
  for (
    const body of [
      "not json",
      {},
      { code: 1 },
      { code: "" },
      { code: "x".repeat(257) },
    ]
  ) {
    const response = await handleAuthExchange(exchange(body), f.deps);
    assertEquals(response?.status, 400, JSON.stringify(body));
  }
  assertEquals(
    (await handleAuthExchange(exchange("x".repeat(17 * 1024)), f.deps))
      ?.status,
    413,
  );
  assertEquals(f.redeemed, []);
});

Deno.test("handleAuthExchange: a completed exchange is audited with the token's name and the person", async () => {
  const learned: Record<string, string>[] = [];
  const f = fixture({ onUsernamesResolved: (names) => learned.push(names) });
  await handleAuthExchange(exchange({ code: "swsc1.abc" }), f.deps);
  await f.emitter.flush();
  const completed = f.sink.events.find((e) =>
    e.action === "auth.exchange.completed"
  );
  assertEquals(completed?.outcome, "success");
  assertEquals(completed?.resourceKind, "server-token");
  assertEquals(completed?.resourceName, "oauth-1234abcd");
  assertEquals(completed?.principalUsername, "alice");
  assertEquals(learned, [{ "sub-alice": "alice" }]);
  assert(!JSON.stringify(f.sink.events).includes("secret"));
});

Deno.test("exchangeTarget: a workspace's name is what its address adds to the root's", () => {
  assertEquals(
    exchangeTarget(undefined, "https://host.example/w/edge-dns"),
    undefined,
  );
  assertEquals(
    exchangeTarget("https://host.example", "https://host.example/w/edge-dns"),
    { rootAddress: "https://host.example", workspace: "edge-dns" },
  );
  assertEquals(
    exchangeTarget(
      "https://host.example/swamp",
      "https://host.example/swamp/w/edge-dns",
    )?.workspace,
    "edge-dns",
  );
  for (
    const address of [
      undefined,
      "https://host.example",
      "https://other.example/w/edge-dns",
      "https://host.example/w/Edge-DNS",
      "https://host.example/w/edge-dns/extra",
    ]
  ) {
    assertThrows(
      () => exchangeTarget("https://host.example", address),
      UserError,
      "--root-address",
    );
  }
});

Deno.test("authInfoBody: names a host root only when asked, leaving every other body unchanged", () => {
  const oauth = {
    mode: "oauth" as const,
    oauthProvider: "https://club.example",
  };
  assertEquals(authInfoBody(oauth, false), {
    mode: "oauth",
    verificationBaseUri: "https://club.example",
  });
  assertEquals(authInfoBody(oauth, true, true), {
    mode: "oauth",
    verificationBaseUri: "https://club.example",
    exchange: true,
    hostRoot: true,
  });
  assertEquals(
    authInfoBody({ mode: "token", oauthProvider: "" }, false, true),
    {
      mode: "token",
      hostRoot: true,
    },
  );
});
