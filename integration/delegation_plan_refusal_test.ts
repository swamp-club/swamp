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

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  type DelegationRouteDeps,
  handleDelegationRequest,
  matchDelegationRoute,
} from "../src/serve/delegation_routes.ts";
import { LeaderLink } from "../src/serve/leader_link.ts";
import type { ServeLeader } from "../src/domain/datastore_v3/serve_leader.ts";
import { REQUIRES_PLAN_MESSAGE } from "../src/serve/serve_link_client.ts";
import {
  SwampHttpError,
  SwampIntegrationClient,
} from "../packages/client/mod.ts";
import { type Rig, START_BODY, withRig } from "./delegation_link_harness.ts";

await initializeLogging({});

const MESSAGE =
  "Links need an active trial or a paid plan for the collective acme.";

function serveRoutes(deps: DelegationRouteDeps): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) =>
      handleDelegationRequest(
        req,
        matchDelegationRoute(new URL(req.url).pathname)!,
        "127.0.0.1",
        deps,
      ),
  );
}

function assertNothingStored(rig: Rig): void {
  assertEquals(rig.directory.all().length, 0);
  assertEquals(rig.audit, []);
}

for (const at of ["capabilities", "start"] as const) {
  Deno.test(`plan refusal: a 403 links_require_plan at ${at} refuses the start with swamp-club's message, once, storing nothing`, async () => {
    await withRig(async (rig) => {
      rig.club.refusePlan = { at, message: MESSAGE };
      const refused = await rig.post("links", START_BODY);
      assertEquals(refused.status, 409);
      assertEquals(refused.body, {
        code: "links_require_plan",
        message: MESSAGE,
      });
      assertEquals(rig.club.starts, at === "start" ? 1 : 0);
      assertNothingStored(rig);
    });
  });
}

Deno.test("plan refusal: swamp-lib sees links_require_plan and swamp-club's message from one request", async () => {
  await withRig(async (rig) => {
    rig.club.refusePlan = { at: "start", message: MESSAGE };
    const server = serveRoutes(rig.routeDeps);
    try {
      const integration = new SwampIntegrationClient(
        `http://127.0.0.1:${server.addr.port}`,
        { credential: rig.credential },
      );
      const error = await assertRejects(
        () =>
          integration.startLink({
            external: {
              platform: "slack",
              teamId: "T1",
              userId: "U1",
              display: "Pat",
              workspace: "Acme",
            },
            ceiling: START_BODY.ceiling as never,
          }),
        SwampHttpError,
      );
      assertEquals(error.status, 409);
      assertEquals(error.code, "links_require_plan");
      assertEquals(error.message, MESSAGE);
      assertEquals(rig.club.starts, 1);
      assertNothingStored(rig);
    } finally {
      await server.shutdown();
    }
  });
});

Deno.test("plan refusal: a follower passes the leader's refusal on unchanged", async () => {
  await withRig(async (rig) => {
    rig.club.refusePlan = { at: "capabilities", message: MESSAGE };
    const leader = serveRoutes(rig.routeDeps);
    const known = () =>
      ({
        instanceId: "leader",
        address: `http://127.0.0.1:${leader.addr.port}`,
      }) as ServeLeader;
    const leaderLink = new LeaderLink({ leader: known });
    const follower = serveRoutes({
      ...rig.routeDeps,
      // a follower answering itself would refuse with links_unavailable
      client: () => undefined,
      followerGate: { role: "follower", leader: known, isStale: () => false },
      leaderLink,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${follower.addr.port}/api/v1/delegations/links`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${rig.credential}`,
          },
          body: JSON.stringify(START_BODY),
        },
      );
      assertEquals(response.status, 409);
      assertEquals(await response.json(), {
        code: "links_require_plan",
        message: MESSAGE,
      });
      assertNothingStored(rig);
    } finally {
      leaderLink.close();
      await follower.shutdown();
      await leader.shutdown();
    }
  });
});

Deno.test("plan refusal: swamp-club's message reaches the app cleaned and capped, or as serve's own wording", async () => {
  const cases: [unknown, string][] = [
    ["Links need\u0007 a\u202e trial\n", "Links need a trial"],
    ["x".repeat(500), "x".repeat(200)],
    ["\u0000\u200b ", REQUIRES_PLAN_MESSAGE],
    [{ text: "not a string" }, REQUIRES_PLAN_MESSAGE],
    [undefined, REQUIRES_PLAN_MESSAGE],
  ];
  for (const [message, expected] of cases) {
    await withRig(async (rig) => {
      rig.club.refusePlan = { at: "start", message };
      const refused = await rig.post("links", START_BODY);
      assertEquals(refused.status, 409);
      assertEquals(refused.body.code, "links_require_plan");
      assertEquals(refused.body.message, expected, JSON.stringify(message));
    });
  }
});

Deno.test("plan refusal: a swamp-club without link routes and one that is down still answer as before", async () => {
  await withRig(async (rig) => {
    rig.club.refuseClient = { status: 404, error: "not_found" };
    const missing = await rig.post("links", START_BODY);
    assertEquals(missing.status, 409);
    assertEquals(missing.body.code, "links_not_enabled");

    rig.club.refuseClient = { status: 403, error: "client_not_collective" };
    const refusedClient = await rig.post("links", START_BODY);
    assertEquals(refusedClient.status, 502);
    assertEquals(refusedClient.body.code, "club_unavailable");

    rig.club.refuseClient = undefined;
    rig.club.down = true;
    const down = await rig.post("links", START_BODY);
    assertEquals(down.status, 502);
    assertEquals(down.body.code, "club_unavailable");
    assert(rig.directory.all().length === 0);
  });
});
