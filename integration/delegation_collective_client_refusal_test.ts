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
import { assertEquals, assertRejects } from "@std/assert";
import { configure, type LogRecord } from "@logtape/logtape";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  COLLECTIVE_CLIENT_MESSAGE,
  type DelegationRouteDeps,
  handleDelegationRequest,
  matchDelegationRoute,
} from "../src/serve/delegation_routes.ts";
import {
  SwampHttpError,
  SwampIntegrationClient,
} from "../packages/client/mod.ts";
import { type Rig, START_BODY, withRig } from "./delegation_link_harness.ts";

await initializeLogging({});

function assertNothingStored(rig: Rig): void {
  assertEquals(rig.directory.all().length, 0);
  assertEquals(rig.audit, []);
}

async function captureRouteWarnings(
  fn: () => Promise<void>,
): Promise<string[]> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [
      {
        category: ["serve", "delegation-routes"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return captured.map((record) =>
    record.message.map((part) => String(part)).join("")
  );
}

for (const at of ["capabilities", "start"] as const) {
  Deno.test(`collective client refusal: a 403 client_not_collective at ${at} answers links_require_collective_client, logs it, and stores nothing`, async () => {
    await withRig(async (rig) => {
      rig.club.refuseClient = {
        status: 403,
        error: "client_not_collective",
        at,
      };
      let refused: Awaited<ReturnType<Rig["post"]>> | undefined;
      const warnings = await captureRouteWarnings(async () => {
        refused = await rig.post("links", START_BODY);
      });
      assertEquals(refused!.status, 409);
      assertEquals(refused!.body, {
        code: "links_require_collective_client",
        message: COLLECTIVE_CLIENT_MESSAGE,
      });
      assertEquals(rig.club.starts, at === "start" ? 1 : 0);
      assertNothingStored(rig);
      assertEquals(warnings.length, 1);
      assertEquals(
        warnings[0].includes("isn't owned by a collective"),
        true,
        warnings[0],
      );
    });
  });
}

Deno.test("collective client refusal: swamp-lib sees links_require_collective_client and serve's message from one request", async () => {
  await withRig(async (rig) => {
    rig.club.refuseClient = { status: 403, error: "client_not_collective" };
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) =>
        handleDelegationRequest(
          req,
          matchDelegationRoute(new URL(req.url).pathname)!,
          "127.0.0.1",
          rig.routeDeps as DelegationRouteDeps,
        ),
    );
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
      assertEquals(error.code, "links_require_collective_client");
      assertEquals(error.message, COLLECTIVE_CLIENT_MESSAGE);
      assertNothingStored(rig);
    } finally {
      await server.shutdown();
    }
  });
});

Deno.test("collective client refusal: any other refused client or 403 still answers club_unavailable", async () => {
  for (
    const refusal of [
      { status: 401, error: "invalid_client" },
      { status: 403, error: "forbidden" },
    ]
  ) {
    await withRig(async (rig) => {
      rig.club.refuseClient = refusal;
      const refused = await rig.post("links", START_BODY);
      assertEquals(refused.status, 502, refusal.error);
      assertEquals(refused.body.code, "club_unavailable");
      assertNothingStored(rig);
    });
  }
});
