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
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import { authenticateDelegatedToken } from "../src/serve/delegated_token_auth.ts";
import {
  DELEGATION_ROUTE_PREFIX,
  handleDelegationRequest,
  matchDelegationRoute,
} from "../src/serve/delegation_routes.ts";
import { handleHttpActionRequest } from "../src/serve/http_action_route.ts";
import { SERVE_ACTION_PATH } from "../src/serve/protocol.ts";
import type { ServerTokenAuthResult } from "../src/serve/token_auth.ts";
import type { ConnectionContext } from "../src/serve/connection.ts";
import {
  DelegatedTokens,
  fixedToken,
  memoryTokenStore,
  SwampActionClient,
  SwampHttpError,
  SwampIntegrationClient,
  type TokenStore,
} from "../packages/client/mod.ts";
import { type Rig, withRig } from "./delegation_link_harness.ts";
import {
  createServeCtx,
  grant,
  saveGatedWorkflow,
} from "./serve_request_harness.ts";
import { captureLogs } from "./remote_secrets_baseline_harness.ts";

await initializeLogging({});

const HOUR = 3_600_000;

const WIDE = Ceiling.parse({
  version: 1,
  ceiling: [{
    actions: ["approve", "read", "run", "signal"],
    resource: "workflow:*",
  }],
});

const EXTERNAL = {
  platform: "slack",
  teamId: "T1",
  userId: "U1",
  display: "Pat",
  workspace: "Acme",
  email: "pat@example.com",
};

interface Serve {
  rig: Rig;
  ctx: ConnectionContext;
  url: string;
  integration: SwampIntegrationClient;
  /** links the person through the library and returns their token holder */
  link: (store?: TokenStore) => Promise<{
    tokens: DelegatedTokens;
    store: TokenStore;
    secrets: string[];
  }>;
}

function authenticateAgainst(rig: Rig) {
  return async (token: string): Promise<ServerTokenAuthResult> => {
    const result = await authenticateDelegatedToken(
      token,
      rig.directory,
      rig.serveClock.now(),
    );
    if (!result.ok) return result as ServerTokenAuthResult;
    const { accessExpiresAt, ...rest } = result;
    return {
      ...rest,
      sessionExpiresAt: accessExpiresAt,
    } as ServerTokenAuthResult;
  };
}

async function withServe(fn: (serve: Serve) => Promise<void>): Promise<void> {
  await withRig(async (rig) => {
    const ctx = createServeCtx(
      rig.repo,
      [grant({
        subject: { kind: "user", name: "person-1" },
        actions: ["read", "run", "approve", "signal"],
        resource: { kind: "workflow", pattern: "*" },
      })],
      {
        detached: true,
        integrations: rig.integrations,
        delegations: rig.directory,
      },
    );
    const authenticate = authenticateAgainst(rig);
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        const path = new URL(req.url).pathname;
        if (path.startsWith(DELEGATION_ROUTE_PREFIX)) {
          const route = matchDelegationRoute(path);
          if (route === undefined) {
            return new Response("Not found", { status: 404 });
          }
          return handleDelegationRequest(
            req,
            route,
            "127.0.0.1",
            rig.routeDeps,
          );
        }
        if (path === SERVE_ACTION_PATH) {
          return handleHttpActionRequest(req, "127.0.0.1", {
            ctx,
            authenticate,
          });
        }
        return new Response("Not found", { status: 404 });
      },
    );
    const url = `http://127.0.0.1:${server.addr.port}`;
    const integration = new SwampIntegrationClient(url, {
      credential: rig.credential,
    });
    const link = async (store: TokenStore = memoryTokenStore()) => {
      const started = await integration.startLink({
        external: EXTERNAL,
        ceiling: WIDE.toDocument() as never,
      });
      rig.club.status = "approved";
      await rig.service.tick();
      const redeemed = await integration.redeemLink(started);
      assert(redeemed.kind === "issued", JSON.stringify(redeemed));
      await store.save(redeemed.tokens.delegationId, redeemed.tokens);
      return {
        store,
        tokens: new DelegatedTokens({
          integration,
          store,
          delegationId: redeemed.tokens.delegationId,
        }),
        secrets: [
          redeemed.tokens.accessToken,
          redeemed.tokens.refreshToken,
          started.redeemSecret,
        ],
      };
    };
    try {
      await fn({ rig, ctx, url, integration, link });
    } finally {
      await waitFor(
        () => (ctx.activeRunRegistry?.size ?? 0) === 0,
        "runs left the registry",
      ).catch(() => {});
      await server.shutdown();
    }
  }, { ceiling: WIDE });
}

async function settled(ctx: ConnectionContext): Promise<void> {
  await waitFor(
    () => (ctx.activeRunRegistry?.size ?? 0) === 0,
    "runs left the registry",
  );
}

function refreshes(rig: Rig): number {
  return rig.audit.filter((e) => e.action === "refreshed").length;
}

Deno.test("swamp-lib over HTTP: link, redeem, then every action type acting as the person", async () => {
  await withServe(async ({ rig, ctx, url, link }) => {
    const { tokens } = await link();
    const actions = new SwampActionClient(url, { token: tokens });
    const name = `gated-${crypto.randomUUID()}`;
    await saveGatedWorkflow(rig.repo, name, "gate");

    const key = `slack:${crypto.randomUUID()}`;
    const started = await actions.run({
      workflowIdOrName: name,
      idempotencyKey: key,
    });
    assert(started.kind === "started", JSON.stringify(started));
    await settled(ctx);

    const replayed = await actions.run({
      workflowIdOrName: name,
      idempotencyKey: key,
    });
    assertEquals(replayed, { ...started, kind: "replayed" });

    const history = await actions.history(started.runId);
    assert(history.kind === "found");
    assertEquals(history.run.status, "suspended");

    const { approvals } = await actions.approvals();
    const row = approvals.find((a) => a.runId === started.runId);
    assert(row?.suspendedAt, "the run waits at its gate");
    const decision = {
      workflowIdOrName: name,
      runId: started.runId,
      stepName: "gate",
      suspendedAt: row.suspendedAt,
    };
    const approved = await actions.approve(decision);
    assert(approved.kind === "decided", JSON.stringify(approved));
    assertEquals(approved.decision.decidedBy, "user:person-1");
    assertEquals(approved.decision.client, "integration:slack-bot");

    // the same button again records nothing new
    const again = await actions.approve(decision);
    assertEquals(again.kind, "already_decided");
    await settled(ctx);

    const second = await actions.run({
      workflowIdOrName: name,
      idempotencyKey: `slack:${crypto.randomUUID()}`,
    });
    assert(second.kind === "started");
    await settled(ctx);
    const secondRow = (await actions.approvals()).approvals.find((a) =>
      a.runId === second.runId
    );
    const rejected = await actions.reject({
      workflowIdOrName: name,
      runId: second.runId,
      stepName: "gate",
      suspendedAt: secondRow!.suspendedAt!,
    });
    assert(rejected.kind === "decided");
    assertEquals(rejected.decision.approved, false);

    const resumed = await actions.resume({
      workflowIdOrName: name,
      runId: second.runId,
    });
    assert(
      resumed.kind === "not_suspended" || resumed.kind === "not_resumable",
      JSON.stringify(resumed),
    );

    const signal = await actions.signal({
      workflow: `missing-${crypto.randomUUID()}`,
      key: "ready",
      payload: {},
    });
    assertEquals(signal.kind, "not_found");

    const refused = await actions.run({
      workflowIdOrName: `missing-${crypto.randomUUID()}`,
      idempotencyKey: `slack:${crypto.randomUUID()}`,
    });
    assert(refused.kind === "not_found" || refused.kind === "refused");
  });
});

Deno.test("swamp-lib over HTTP: an expired access token is refreshed after its 401, and early when it is due", async () => {
  await withServe(async ({ rig, url, link, integration }) => {
    const { tokens, store } = await link();
    const actions = new SwampActionClient(url, { token: tokens });
    await actions.approvals();
    assertEquals(refreshes(rig), 0);

    rig.serveClock.offsetMs = HOUR + 60_000;
    await actions.approvals();
    assertEquals(refreshes(rig), 1);

    const early = new DelegatedTokens({
      integration,
      store,
      delegationId: tokens.delegationId,
      now: () => Date.now() + 2 * HOUR,
    });
    await new SwampActionClient(url, { token: early }).approvals();
    assertEquals(refreshes(rig), 2);
  });
});

Deno.test("swamp-lib over HTTP: two copies of an app refreshing at once on one store both work and the link stands", async () => {
  await withServe(async ({ rig, url, link, integration }) => {
    const { tokens, store } = await link();
    const copy = (): TokenStore => ({
      load: (id) => store.load(id),
      save: (id, t) => store.save(id, t),
    });
    const due = () => Date.now() + 2 * HOUR;
    const holders = [copy(), copy(), copy()].map((s) =>
      new DelegatedTokens({
        integration,
        store: s,
        delegationId: tokens.delegationId,
        now: due,
      })
    );
    const results = await Promise.all(
      holders.map((h) => new SwampActionClient(url, { token: h }).approvals()),
    );
    assertEquals(results.length, 3);
    assertEquals(refreshes(rig), 3);
    assertEquals((await rig.store.read(tokens.delegationId))?.phase, "issued");
  });
});

Deno.test("swamp-lib over HTTP: a refused refresh reports the link as ended; a held refresh reports try again", async () => {
  await withServe(async ({ rig, url, link, integration }) => {
    const { tokens, store } = await link();
    const due = new DelegatedTokens({
      integration,
      store,
      delegationId: tokens.delegationId,
      now: () => Date.now() + 2 * HOUR,
    });

    rig.team.capability = { ok: false, instances: ["old (host)"] };
    const held = await assertRejects(() => due.accessToken(), SwampHttpError);
    assertEquals(held.code, "team_not_ready");
    assertEquals((await rig.store.read(tokens.delegationId))?.phase, "issued");
    rig.team.capability = { ok: true };

    const stored = await store.load(tokens.delegationId);
    await integration.endLink(stored!.refreshToken);
    const ended = await assertRejects(
      () => new SwampActionClient(url, { token: due }).approvals(),
      SwampHttpError,
    );
    assertEquals(ended.code, "link_ended");
    assert(ended.linkEnded);
  });
});

Deno.test("swamp-lib over HTTP: a record written by a previous build still accepts its two access tokens", async () => {
  await withServe(async ({ rig, url, link, integration }) => {
    const { tokens, store } = await link();
    const first = (await store.load(tokens.delegationId))!.accessToken;
    const out = await integration.refresh(
      (await store.load(tokens.delegationId))!.refreshToken,
    );
    assert(out.kind === "refreshed");
    await rig.store.transition(tokens.delegationId, (current) => {
      const { olderAccess: _dropped, ...legacy } = current!.tokens!;
      return Promise.resolve({
        write: { ...current!, tokens: legacy },
        value: null,
      });
    });
    for (const token of [first, out.accessToken]) {
      const actions = new SwampActionClient(url, { token: fixedToken(token) });
      assertEquals(Array.isArray((await actions.approvals()).approvals), true);
    }
  });
});

Deno.test("swamp-lib over HTTP: an older serve without the routes answers route_unavailable", async () => {
  const old = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response("Not found", { status: 404 }),
  );
  try {
    const url = `http://127.0.0.1:${old.addr.port}`;
    const action = await assertRejects(
      () => new SwampActionClient(url, { token: "t" }).approvals(),
      SwampHttpError,
    );
    assertEquals(action.code, "route_unavailable");
    const linkError = await assertRejects(
      () =>
        new SwampIntegrationClient(url, { credential: "swi1.a.b" }).startLink({
          external: EXTERNAL,
          ceiling: WIDE.toDocument() as never,
        }),
      SwampHttpError,
    );
    assertEquals(linkError.code, "route_unavailable");
  } finally {
    await old.shutdown();
  }
});

Deno.test("swamp-lib over HTTP: calls made to fail leave no token or credential in errors or logs", async () => {
  await withServe(async ({ rig, url, link, integration }) => {
    const errors: unknown[] = [];
    let secrets: string[] = [rig.credential];
    const logs = await captureLogs(async () => {
      const linked = await link();
      secrets = [...secrets, ...linked.secrets];
      const stored = (await linked.store.load(linked.tokens.delegationId))!;
      const wrongCredential = new SwampIntegrationClient(url, {
        credential: `${rig.credential}x`,
      });
      await wrongCredential.refresh(stored.refreshToken).catch((e) =>
        errors.push(e)
      );
      await integration.refresh(`${stored.refreshToken.slice(0, -1)}0`)
        .then((outcome) => errors.push(outcome))
        .catch((e) => errors.push(e));
      await integration.endLink(stored.accessToken);
      await new SwampActionClient(url, {
        token: fixedToken(stored.accessToken),
      })
        .approvals().catch((e) => errors.push(e));
      await linked.tokens.accessToken().catch((e) => errors.push(e));
      await new DelegatedTokens({
        integration,
        store: linked.store,
        delegationId: linked.tokens.delegationId,
        now: () => Date.now() + 2 * HOUR,
      }).accessToken().catch((e) => errors.push(e));
    });
    assert(errors.length >= 3, `expected failures, got ${errors.length}`);
    const rendered = [
      ...errors.flatMap((e) => [
        String(e),
        JSON.stringify(e),
        Deno.inspect(e),
        e instanceof Error ? String(e.stack) : "",
      ]),
      ...logs.map((l) => JSON.stringify(l)),
      Deno.inspect(integration),
      JSON.stringify(integration),
    ];
    for (const secret of secrets) {
      for (const text of rendered) {
        assert(!text.includes(secret), `a secret leaked into: ${text}`);
      }
    }
  });
});
