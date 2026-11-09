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
  accessTokenTiming,
  SwampIntegrationClient,
} from "./integration_client.ts";
import { SwampHttpError } from "./http_errors.ts";
import { FAST, scriptedFetch, SERVE } from "./http_test_helpers.ts";

const CREDENTIAL = "swi1.slack-bot.credential-secret";
const LATER = new Date(Date.now() + 3_600_000).toISOString();

function client(fetch: typeof globalThis.fetch) {
  return new SwampIntegrationClient(SERVE, {
    credential: CREDENTIAL,
    fetch,
    ...FAST,
  });
}

Deno.test("SwampIntegrationClient.startLink: sends the identity in serve's shape with the credential", async () => {
  const started = {
    pendingId: "p",
    redeemSecret: "s",
    consentUrl: "https://club/c",
    expiresIn: 600,
    interval: 5,
  };
  const { fetch, sent } = scriptedFetch([{ status: 201, body: started }]);
  const out = await client(fetch).startLink({
    external: {
      platform: "slack",
      teamId: "T",
      userId: "U",
      display: "pat",
      workspace: "acme",
    },
    ceiling: {
      version: 1,
      ceiling: [{ actions: ["run"], resource: "workflow:d" }],
    },
  });
  assertEquals(out, started);
  assertEquals(sent[0].url, `${SERVE}/api/v1/delegations/links`);
  assertEquals(sent[0].authorization, `Bearer ${CREDENTIAL}`);
  assertEquals((sent[0].body.external as Record<string, string>).team_id, "T");
});

Deno.test("SwampIntegrationClient.redeemLink: each of serve's answers is an outcome", async () => {
  const issued = {
    status: "issued",
    delegationId: "d1",
    accessToken: "swda1.a",
    accessTokenExpiresAt: LATER,
    refreshToken: "swdr1.r",
    expiresAt: LATER,
    person: { username: "pat" },
  };
  const { fetch } = scriptedFetch([
    { status: 202, body: { status: "pending", interval: 5 } },
    { status: 200, body: { status: "refused", reason: "declined" } },
    { status: 200, body: { status: "ended", cause: "replaced" } },
    { status: 409, body: { code: "already_redeemed", message: "m" } },
    { status: 200, body: issued },
  ]);
  const c = client(fetch);
  const link = { pendingId: "p", redeemSecret: "s" };
  assertEquals(await c.redeemLink(link), {
    kind: "pending",
    intervalSeconds: 5,
  });
  assertEquals(await c.redeemLink(link), {
    kind: "refused",
    reason: "declined",
  });
  assertEquals(await c.redeemLink(link), { kind: "ended", cause: "replaced" });
  assertEquals(await c.redeemLink(link), { kind: "already_redeemed" });
  const out = await c.redeemLink(link);
  assert(out.kind === "issued");
  assertEquals(out.tokens.refreshToken, "swdr1.r");
  assertEquals(out.tokens.delegationId, "d1");
  assert(out.tokens.accessTokenLifetimeMs > 3_500_000);
});

Deno.test("SwampIntegrationClient.redeemLink: a lost reply is not sent again, since tokens issue once", async () => {
  const { fetch, sent } = scriptedFetch(["network_error"]);
  await assertRejects(
    () => client(fetch).redeemLink({ pendingId: "p", redeemSecret: "s" }),
    SwampHttpError,
  );
  assertEquals(sent.length, 1);
});

Deno.test("SwampIntegrationClient.refresh: a new access token; an older serve's rotated refresh token is passed on", async () => {
  const { fetch } = scriptedFetch([
    {
      status: 200,
      body: {
        status: "refreshed",
        accessToken: "a2",
        accessTokenExpiresAt: LATER,
        expiresIn: 3600,
      },
    },
    {
      status: 200,
      body: {
        status: "issued",
        accessToken: "a3",
        accessTokenExpiresAt: LATER,
        refreshToken: "r2",
      },
    },
  ]);
  const c = client(fetch);
  const first = await c.refresh("r1");
  assert(first.kind === "refreshed");
  assertEquals(first.refreshToken, undefined);
  const second = await c.refresh("r1");
  assert(second.kind === "refreshed");
  assertEquals(second.refreshToken, "r2");
});

Deno.test("SwampIntegrationClient.refresh: a refusal says whether the link ended or the person is not admitted", async () => {
  const refused = (reason?: string) => ({
    status: 401,
    body: {
      code: "invalid_grant",
      message: "m",
      ...(reason ? { reason } : {}),
    },
  });
  const { fetch } = scriptedFetch([
    refused("not_admitted"),
    refused("expired"),
    refused(),
  ]);
  const c = client(fetch);
  assertEquals(await c.refresh("r"), { kind: "not_admitted" });
  assertEquals(await c.refresh("r"), { kind: "link_ended", reason: "expired" });
  assertEquals(await c.refresh("r"), { kind: "link_ended", reason: "unknown" });
});

Deno.test("SwampIntegrationClient.refresh: a lost reply is sent again, and team_not_ready throws for later", async () => {
  const ok = {
    status: 200,
    body: {
      status: "refreshed",
      accessToken: "a",
      accessTokenExpiresAt: LATER,
    },
  };
  const lost = scriptedFetch(["network_error", ok]);
  assertEquals((await client(lost.fetch).refresh("r")).kind, "refreshed");
  assertEquals(lost.sent.map((s) => s.body.refreshToken), ["r", "r"]);

  const waiting = scriptedFetch([
    { status: 503, body: { code: "team_not_ready", message: "upgrade" } },
  ]);
  const error = await assertRejects(
    () => client(waiting.fetch).refresh("r"),
    SwampHttpError,
  );
  assertEquals(error.code, "team_not_ready");
  assertEquals(waiting.sent.length, 1);
});

Deno.test("accessTokenTiming: measures life on serve's clock, so a skewed local clock moves nothing", () => {
  const serveNow = Date.UTC(2026, 0, 1, 12);
  const localNow = serveNow + 45 * 60_000; // this clock runs 45 minutes fast
  const expiresAt = new Date(serveNow + 3_600_000).toISOString();
  const timing = accessTokenTiming(
    { serverDateMs: serveNow, receivedAtMs: localNow },
    expiresAt,
  );
  assertEquals(timing.lifetimeMs, 3_600_000);
  assertEquals(timing.deadlineMs, localNow + 3_600_000);
  assertEquals(
    accessTokenTiming({ receivedAtMs: localNow }, expiresAt, 3600).lifetimeMs,
    3_600_000,
  );
});

Deno.test("SwampIntegrationClient: the credential never appears in JSON or printed form", () => {
  const c = client(scriptedFetch([]).fetch);
  assert(!JSON.stringify(c).includes("credential-secret"));
  assert(!Deno.inspect(c).includes("credential-secret"));
});
