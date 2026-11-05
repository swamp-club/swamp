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
import { HubAdminClient } from "./hub_admin_client.ts";

Deno.test("HubAdminClient: issues a manage lease naming its client, and a renewal of a forgotten lease or a gone hub is null", async () => {
  const bodies: unknown[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request) => {
      if (request.headers.get("authorization") !== "Bearer admin") {
        return new Response(null, { status: 401 });
      }
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/hub/leases") {
        bodies.push(await request.json());
        return Response.json({ id: "l1", token: "t1" }, { status: 201 });
      }
      if (path === "/hub/leases/l1") return Response.json({ pages: 2 });
      return Response.json({ error: "unknown_lease" }, { status: 404 });
    },
  );
  const port = server.addr.port;
  const client = new HubAdminClient(port, "admin");
  try {
    assertEquals(
      await client.issueLease({
        scope: "all",
        manage: true,
        client: "hub",
        pid: 12,
      }),
      { id: "l1", token: "t1" },
    );
    assertEquals(bodies, [{
      scope: "all",
      manage: true,
      client: "hub",
      pid: 12,
    }]);
    assertEquals(await client.renew("l1"), { pages: 2 });
    assertEquals(await client.renew("other"), null);
  } finally {
    await server.shutdown();
  }
  assertEquals(await client.renew("l1"), null);
});
