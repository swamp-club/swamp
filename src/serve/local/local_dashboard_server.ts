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
 * One workspace's dashboard server, a child of the local hub
 * (`swamp start` / `swamp dashboard`). It answers the serve WebSocket
 * protocol in-process for its repo with auth mode `none`, and takes requests
 * only from the hub, which holds its token. Nothing in `swamp serve` is
 * changed: this reuses `handleConnection` as it is.
 */

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

export interface LocalDashboardServerOptions {
  ctx: ConnectionContext;
  healthCollector: HealthCollector;
  /**
   * Every request must carry this token (header `x-swamp-hub-token`, or the
   * `bearer.<token>` subprotocol on the WebSocket). Only the hub has it; the
   * browser never talks to this server directly.
   */
  hubToken: string;
  /**
   * Runs other swamp processes are executing in this repo right now (the
   * CLI writes them to the run tracker). They join the health snapshot's
   * active runs, so the dashboard refreshes when a CLI run starts or ends.
   */
  trackedRuns?: () => HealthSnapshotRun[];
  /**
   * True while this server runs something it started: the hub asks before
   * stopping an idle child, since those runs would die with it.
   */
  busy?: () => boolean;
}

/**
 * This server's own active runs plus the tracked ones it doesn't already
 * have, matched on run id.
 */
export function mergeActiveRuns(
  own: readonly HealthSnapshotRun[],
  tracked: readonly HealthSnapshotRun[],
): HealthSnapshotRun[] {
  const ids = new Set(own.map((r) => r.runId));
  return [...own, ...tracked.filter((r) => !ids.has(r.runId))];
}

/** A tracker row for a running workflow, as a health snapshot run. */
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
  const collect = async (signal: AbortSignal): Promise<HealthSnapshot> => {
    const snapshot = await healthCollector.collect(signal);
    const tracked = options.trackedRuns?.() ?? [];
    return tracked.length === 0 ? snapshot : {
      ...snapshot,
      activeRuns: mergeActiveRuns(snapshot.activeRuns, tracked),
    };
  };
  const ac = new AbortController();
  let port = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req, info) => {
      // DNS rebinding: only our own loopback authority.
      const host = req.headers.get("host");
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return new Response("Misdirected request", { status: 421 });
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

      if (req.method === "GET" && url.pathname === "/local/busy") {
        return Response.json({ busy: options.busy?.() ?? false });
      }
      if (req.method === "GET" && url.pathname === "/auth/info") {
        return Response.json({ mode: "none", local: true });
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
