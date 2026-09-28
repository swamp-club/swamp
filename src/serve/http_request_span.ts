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

import {
  SpanStatusCode,
  withServerSpan,
} from "../infrastructure/tracing/mod.ts";

// Routes `swamp serve` answers at a fixed path. Kept in step with the request
// handler in src/cli/commands/serve.ts.
const EXACT_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/health",
  "/ready",
  "/auth/info",
  "/auth/device",
  "/auth/device/token",
  "/api/v1/health",
  "/api/v1/health/stream",
  "/api/v1/cluster/instances",
  "/api/v1/serve/config",
  "/api/v1/cancel",
  "/internal/runs",
  "/dashboard",
]);

const CANCEL_RUN_PATTERN =
  /^\/api\/v1\/cancel\/(workflow-run|method-run)\/[^/]+$/;
const DATA_PLANE_ROOT_PATTERN = /^\/(data|bundle)(?:\/|$)/;

/**
 * Maps a request path to a low-cardinality route template for span names and
 * the `http.route` attribute. Returns `undefined` for any path that is not a
 * known route — including operator-configured webhook routes, which may carry
 * a secret segment, and arbitrary paths from scanners.
 */
export function resolveHttpRoute(pathname: string): string | undefined {
  if (EXACT_ROUTES.has(pathname)) return pathname;
  if (CANCEL_RUN_PATTERN.test(pathname)) return "/api/v1/cancel/{kind}/{id}";
  if (pathname.startsWith("/dashboard/")) return "/dashboard/*";
  // The data plane owns everything under these two roots (data_plane.ts).
  const root = DATA_PLANE_ROOT_PATTERN.exec(pathname)?.[1];
  if (root) return `/${root}/*`;
  return undefined;
}

function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/**
 * Wraps a `Deno.serve` handler so every HTTP request runs inside a root
 * SERVER span named `{method} {route}` (or `{method}` when the route is
 * unknown), per the OpenTelemetry HTTP semantic conventions. The span is the
 * active context for all work the request does.
 *
 * WebSocket upgrades pass through untraced: the connection outlives the
 * upgrade, and every message on it would otherwise join one trace.
 *
 * Only a 5xx response or a thrown error marks the span ERROR. No query
 * string, header or body is recorded, and the path is recorded only for a
 * known route. The span ends when the handler returns its Response, so a
 * streamed body is not included in its duration.
 */
export function traceHttpRequests<A extends Deno.Addr = Deno.Addr>(
  handler: Deno.ServeHandler<A>,
): Deno.ServeHandler<A> {
  return (req, info) => {
    if (isWebSocketUpgrade(req)) return handler(req, info);

    const pathname = new URL(req.url).pathname;
    const route = resolveHttpRoute(pathname);
    const name = route ? `${req.method} ${route}` : req.method;
    const attributes: Record<string, string> = {
      "http.request.method": req.method,
    };
    if (route) {
      attributes["http.route"] = route;
      attributes["url.path"] = pathname;
    }

    return withServerSpan(name, attributes, async (span) => {
      const response = await handler(req, info);
      span.setAttribute("http.response.status_code", response.status);
      if (response.status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      return response;
    });
  };
}
