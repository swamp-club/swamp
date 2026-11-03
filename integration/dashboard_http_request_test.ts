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
  type HttpReadOutcome,
  requestOverHttp,
  SERVE_REQUEST_PATH,
} from "../packages/dashboard/src/client/http_request.ts";
import { ComponentHealthChecker } from "../src/serve/component_health_checker.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { HealthCollector } from "../src/serve/health_collector.ts";
import { startLocalDashboardServer } from "../src/serve/local/local_dashboard_server.ts";
import {
  createWorkspaceHub,
  type HubChild,
} from "../src/serve/local/workspace_hub.ts";
import { RunMetricsTracker } from "../src/serve/run_metrics_tracker.ts";
import {
  createServeCtx,
  OVER_FRAME_LIMIT_BYTES,
  saveLargeText,
  withServeRepo,
} from "./serve_request_harness.ts";

const LOCAL_TOKEN = "local-token-for-tests";

function startChild(ctx: ConnectionContext): HubChild {
  const token = crypto.randomUUID();
  const server = startLocalDashboardServer({
    ctx,
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
    hubToken: token,
  });
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => resolveExited = resolve);
  return {
    port: server.port,
    token,
    exited,
    async stop() {
      await server.shutdown();
      resolveExited();
    },
  };
}

async function withHub(
  ctx: ConnectionContext,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const hub = createWorkspaceHub({
    token: LOCAL_TOKEN,
    resolveWorkspace: (name) =>
      Promise.resolve(name === "alpha" ? ctx.repoDir : null),
    listWorkspaces: () =>
      Promise.resolve([{ name: "alpha", path: ctx.repoDir }]),
    spawnChild: () => Promise.resolve(startChild(ctx)),
  });
  const front = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) =>
      await hub.handle(req, () => {}) ??
        new Response("not a hub route", { status: 404 }),
  );
  try {
    await fn(`http://127.0.0.1:${front.addr.port}`);
  } finally {
    await hub.shutdown();
    await front.shutdown();
  }
}

function readThroughHub(
  base: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<HttpReadOutcome> {
  return requestOverHttp(
    fetch,
    `${base}/w/alpha${SERVE_REQUEST_PATH}`,
    { "x-swamp-local-token": LOCAL_TOKEN, "accept-encoding": "gzip" },
    { type, id: crypto.randomUUID(), payload },
  );
}

Deno.test({
  name:
    "dashboard HTTP read: a data.get reply over the 64 MiB frame limit reaches the dashboard through the workspace hub",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      await saveLargeText(repo);
      await withHub(createServeCtx(repo), async (base) => {
        const outcome = await readThroughHub(base, "data.get", {
          modelIdOrName: "big-model",
          dataName: "big",
        });
        assertEquals(outcome.kind, "payload");
        const reply = (outcome as { value: unknown }).value as {
          data: { content: string };
        };
        assertEquals(reply.data.content.length, OVER_FRAME_LIMIT_BYTES);
      });
    });
  },
});

Deno.test({
  name:
    "dashboard HTTP read: a read the hub does not forward is sent back to the socket",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      await withHub(createServeCtx(repo), async (base) => {
        const outcome = await readThroughHub(base, "data.list", {
          modelIdOrName: "big-model",
        });
        assertEquals(outcome, { kind: "route_missing" });
      });
    });
  },
});
