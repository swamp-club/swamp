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
  type LocalDashboardServer,
  startLocalDashboardServer,
} from "../src/serve/local/local_dashboard_server.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { HealthCollector } from "../src/serve/health_collector.ts";
import { RunMetricsTracker } from "../src/serve/run_metrics_tracker.ts";
import { ComponentHealthChecker } from "../src/serve/component_health_checker.ts";

const TOKEN = "hub-token-for-tests";

/**
 * The routes under test never touch the repo, so the connection context is
 * an empty stand-in.
 */
async function withServer(
  fn: (server: LocalDashboardServer, base: string) => Promise<void>,
): Promise<void> {
  const server = startLocalDashboardServer({
    ctx: {} as unknown as ConnectionContext,
    healthCollector: new HealthCollector({
      instanceId: "test",
      deploymentMode: "local",
      startedAt: 0,
      isReady: () => true,
      activeRunRegistry: null,
      metricsTracker: new RunMetricsTracker(),
      componentChecker: new ComponentHealthChecker({}),
      workerProvider: null,
      scheduleProvider: null,
      scheduleEnabled: false,
      webhookProvider: null,
      remoteOnly: false,
    }),
    hubToken: TOKEN,
  });
  try {
    await fn(server, `http://127.0.0.1:${server.port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("localDashboardServer: refuses a request without the hub token", async () => {
  await withServer(async (_server, base) => {
    const attempts: Record<string, string>[] = [
      {},
      { "x-swamp-hub-token": "wrong" },
    ];
    for (const headers of attempts) {
      const res = await fetch(`${base}/auth/info`, { headers });
      assertEquals(res.status, 401);
      await res.body?.cancel();
    }
  });
});

Deno.test("localDashboardServer: refuses a WebSocket without the hub token", async () => {
  await withServer(async (_server, base) => {
    const res = await fetch(base + "/", {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-protocol": "bearer.wrong",
      },
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });
});

Deno.test("localDashboardServer: tells the dashboard it is local, with no login", async () => {
  await withServer(async (_server, base) => {
    const res = await fetch(`${base}/auth/info`, {
      headers: { "x-swamp-hub-token": TOKEN },
    });
    assertEquals(await res.json(), { mode: "none", local: true });
  });
});

Deno.test("localDashboardServer: answers a local health snapshot with scheduling off", async () => {
  await withServer(async (_server, base) => {
    const res = await fetch(`${base}/api/v1/health`, {
      headers: { "x-swamp-hub-token": TOKEN },
    });
    const body = await res.json();
    assertEquals(body.deploymentMode, "local");
    assertEquals(body.scheduling.enabled, false);
    assertEquals(body.workers, []);
  });
});

Deno.test("localDashboardServer: answers a foreign Host with 421", async () => {
  await withServer(async (server) => {
    const conn = await Deno.connect({
      hostname: "127.0.0.1",
      port: server.port,
    });
    try {
      await conn.write(
        new TextEncoder().encode(
          "GET /auth/info HTTP/1.1\r\nHost: evil.example\r\n" +
            `x-swamp-hub-token: ${TOKEN}\r\nConnection: close\r\n\r\n`,
        ),
      );
      const buf = new Uint8Array(64);
      const n = await conn.read(buf);
      const status = new TextDecoder().decode(buf.subarray(0, n ?? 0));
      assertEquals(status.startsWith("HTTP/1.1 421"), true, status);
    } finally {
      conn.close();
    }
  });
});
