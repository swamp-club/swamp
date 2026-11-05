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
import type { HubRecord } from "../persistence/hub_record.ts";
import { hubRunsEngine, probeHub } from "./hub_probe.ts";

function recordFor(port: number, pid = Deno.pid): HubRecord {
  return {
    pid,
    port,
    adminToken: "admin-secret",
    version: "1",
    gitSha: "go",
    engine: "/opt/swamp",
    engineVersion: "1",
    engineGitSha: "abc",
    autoExit: true,
  };
}

async function withHub(
  handler: (request: Request) => Response | Promise<Response>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    handler,
  );
  try {
    await fn(server.addr.port);
  } finally {
    await server.shutdown();
  }
}

Deno.test("probeHub: live when the hub answers its admin token with the recorded pid", async () => {
  await withHub((request) => {
    if (request.headers.get("authorization") !== "Bearer admin-secret") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return Response.json({ pid: Deno.pid, port: 1 });
  }, async (port) => {
    assertEquals(await probeHub(recordFor(port)), "live");
    assertEquals(
      await probeHub({ ...recordFor(port), adminToken: "stale" }),
      "dead",
    );
  });
});

Deno.test("probeHub: a recycled port answering for another hub is dead", async () => {
  await withHub(() => Response.json({ pid: 1 }), async (port) => {
    assertEquals(await probeHub(recordFor(port)), "dead");
  });
});

Deno.test("probeHub: nothing listening is dead", async () => {
  let port = 0;
  await withHub(() => new Response(), (p) => {
    port = p;
    return Promise.resolve();
  });
  assertEquals(await probeHub(recordFor(port)), "dead");
});

Deno.test("hubRunsEngine: same engine and build, or the same engine when the build is unstamped", () => {
  const record = { engine: "/opt/swamp", engineGitSha: "abc" };
  assertEquals(hubRunsEngine(record, "/opt/swamp", "abc"), true);
  assertEquals(hubRunsEngine(record, "/opt/swamp", "def"), false);
  assertEquals(hubRunsEngine(record, "/other/swamp", "abc"), false);
  assertEquals(hubRunsEngine(record, "/opt/swamp", "unknown"), true);
});
