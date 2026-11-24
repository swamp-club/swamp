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

/**
 * auth mode none, taking requests only from the hub, which holds the token;
 * reuses handleConnection unchanged
 */

import { cachedAppCatalog, isAppPath, serveAppRoute } from "../app_assets.ts";
import { timingSafeEqual } from "../../domain/crypto/timing_safe_equal.ts";
import { HUB_TOKEN_HEADER } from "./hub_token.ts";
import { handleConnection } from "../connection.ts";
import type { ConnectionContext } from "../handlers/shared.ts";
import {
  resolveConnectionCompression,
  setConnectionCompression,
  setConnectionSourceIp,
} from "../handlers/shared.ts";
import type {
  HealthCollector,
  HealthSnapshot,
  HealthSnapshotRun,
} from "../health_collector.ts";
import { createHealthStreamResponse } from "../health_stream.ts";
import { handleHttpRequest } from "../http_request_route.ts";
import { SERVE_REQUEST_PATH } from "../protocol.ts";
import {
  DashboardThemeStore,
  serveDashboardTheme,
} from "../dashboard_theme.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  misdirectedResponse,
  refusedHost,
  RefusedHostLog,
} from "./misdirected_host.ts";

const logger = getSwampLogger(["serve", "local-dashboard"]);

export interface LocalDashboardServerOptions {
  ctx: ConnectionContext;
  healthCollector: HealthCollector;
  /** only the hub has the token; the browser never talks to this server directly */
  hubToken: string;
  /**
   * runs other swamp processes execute in this repo join the active runs, so
   * the dashboard refreshes when a CLI run starts or ends
   */
  trackedRuns?: () => HealthSnapshotRun[];
  /**
   * true while this server runs something it started; the hub asks before
   * stopping an idle child since those runs would die with it
   */
  busy?: () => boolean;
  /** where the dashboard theme is read from */
  repoDir?: string;
}

export function mergeActiveRuns(
  own: readonly HealthSnapshotRun[],
  tracked: readonly HealthSnapshotRun[],
): HealthSnapshotRun[] {
  const ids = new Set(own.map((r) => r.runId));
  return [...own, ...tracked.filter((r) => !ids.has(r.runId))];
}

export function trackedWorkflowRuns(
  running: readonly {
    id: string;
    runKind: string;
    workflowName: string | null;
    startedAt: Date;
    heartbeatAt: Date;
  }[],
  now: number,
  staleTtlMs: number,
): HealthSnapshotRun[] {
  return running
    // A run whose process died stops heartbeating; leave it out.
    .filter((r) =>
      r.runKind === "workflow" && r.workflowName !== null &&
      now - r.heartbeatAt.getTime() < staleTtlMs
    )
    .map((r) => ({
      runId: r.id,
      kind: "workflow",
      resourceName: r.workflowName!,
      durationMs: now - r.startedAt.getTime(),
      principalId: null,
    }));
}

function hubTokenOffered(req: Request): string | null {
  const header = req.headers.get(HUB_TOKEN_HEADER);
  if (header) return header;
  const protocols = req.headers.get("sec-websocket-protocol") ?? "";
  for (const p of protocols.split(",")) {
    const trimmed = p.trim();
    if (trimmed.startsWith("bearer.")) return trimmed.slice("bearer.".length);
  }
  return null;
}

export interface LocalDashboardServer {
  readonly port: number;
  shutdown(): Promise<void>;
}

export function startLocalDashboardServer(
  options: LocalDashboardServerOptions,
): LocalDashboardServer {
  const { ctx, healthCollector, hubToken } = options;
  const themes = options.repoDir === undefined
    ? undefined
    : new DashboardThemeStore(options.repoDir);
  const collect = async (signal: AbortSignal): Promise<HealthSnapshot> => {
    const snapshot = await healthCollector.collect(signal);
    const tracked = options.trackedRuns?.() ?? [];
    return {
      ...snapshot,
      ...(tracked.length === 0
        ? {}
        : { activeRuns: mergeActiveRuns(snapshot.activeRuns, tracked) }),
      ...(themes ? { themeVersion: await themes.version() } : {}),
    };
  };
  const appRouteCatalog = ctx.appDeps && cachedAppCatalog(ctx.appDeps.catalog);
  const ac = new AbortController();
  const refusedHostLog = new RefusedHostLog((message) => logger.warn(message));
  let port = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req, info) => {
      // DNS rebinding: only our own loopback authority.
      const host = req.headers.get("host");
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        // Only the hub reaches this server, so --trusted-hosts is no fix here.
        const refused = refusedHost(host, null);
        refusedHostLog.note(refused);
        return misdirectedResponse(refused);
      }
      const url = new URL(req.url);
      const offered = hubTokenOffered(req);
      if (offered === null || !timingSafeEqual(offered, hubToken)) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const remoteAddr = info.remoteAddr.hostname;
        const { socket, response } = Deno.upgradeWebSocket(
          req,
          { protocol: `bearer.${hubToken}` },
        );
        setConnectionSourceIp(socket, remoteAddr);
        setConnectionCompression(
          socket,
          resolveConnectionCompression(req.url),
        );
        handleConnection(socket, ctx, null);
        return response;
      }

      if (ctx.appDeps && appRouteCatalog && isAppPath(url.pathname)) {
        const answer = await serveAppRoute(req, {
          ...ctx.appDeps,
          catalog: appRouteCatalog,
          trustBaseHeader: true,
        });
        if (answer) return answer;
      }

      if (url.pathname === SERVE_REQUEST_PATH) {
        return await handleHttpRequest(req, info.remoteAddr.hostname, {
          ctx,
          // auth mode none never asks; refuse rather than trust a token here
          authenticate: () =>
            Promise.resolve({
              ok: false,
              error: "the local dashboard takes no tokens",
              reason: "invalid-format",
            }),
        });
      }
      if (req.method === "GET" && url.pathname === "/local/busy") {
        return Response.json({ busy: options.busy?.() ?? false });
      }
      if (req.method === "GET" && url.pathname === "/auth/info") {
        return Response.json({ mode: "none", local: true });
      }
      if (themes !== undefined) {
        const theme = await serveDashboardTheme(req, themes);
        if (theme) return theme;
      }
      if (url.pathname === "/auth/dashboard/session") {
        return new Response(null, { status: 401 });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/health") {
        return Response.json(await collect(ac.signal));
      }
      if (req.method === "GET" && url.pathname === "/api/v1/health/stream") {
        return createHealthStreamResponse({
          collect,
          intervalParam: url.searchParams.get("interval"),
          lastEventId: req.headers.get("Last-Event-ID"),
          serverSignal: ac.signal,
          requestSignal: req.signal,
        });
      }
      return new Response("Not found", { status: 404 });
    },
  );
  port = server.addr.port;
  return {
    port,
    shutdown: async () => {
      ac.abort();
      await server.shutdown();
    },
  };
}
