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
  type ServerSpanOptions,
  SpanStatusCode,
  withServerSpan,
} from "../infrastructure/tracing/mod.ts";
import {
  datastoreRouteTemplate,
  matchDatastoreRoute,
} from "./datastore_routes.ts";
import { SERVE_ACTION_PATH, SERVE_REQUEST_PATH } from "./protocol.ts";

// Routes `swamp serve` answers at a fixed path; serve_http_route_span_rules_test
// fails when the handler in src/cli/commands/serve.ts answers one missing here.
const EXACT_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/health",
  "/ready",
  "/auth/info",
  "/auth/device",
  "/auth/device/token",
  "/auth/dashboard/device",
  "/auth/dashboard/device/token",
  "/auth/dashboard/session",
  "/api/v1/health",
  "/api/v1/health/stream",
  "/api/v1/cluster/instances",
  "/api/v1/serve/config",
  "/api/v1/cancel",
  SERVE_REQUEST_PATH,
  SERVE_ACTION_PATH,
  "/internal/runs",
  "/dashboard",
]);

const CANCEL_RUN_PATTERN =
  /^\/api\/v1\/cancel\/(workflow-run|method-run)\/[^/]+$/;
const DATA_PLANE_ROOT_PATTERN = /^\/(data|bundle)(?:\/|$)/;

/**
 * unknown paths return undefined, including operator webhook routes, which may
 * carry a secret segment, and scanner paths
 */
export function resolveHttpRoute(pathname: string): string | undefined {
  if (EXACT_ROUTES.has(pathname)) return pathname;
  if (CANCEL_RUN_PATTERN.test(pathname)) return "/api/v1/cancel/{kind}/{id}";
  if (pathname.startsWith("/dashboard/")) return "/dashboard/*";
  const datastore = matchDatastoreRoute(pathname);
  if (datastore !== undefined) return datastoreRouteTemplate(datastore);
  // The data plane owns everything under these two roots (data_plane.ts).
  const root = DATA_PLANE_ROOT_PATTERN.exec(pathname)?.[1];
  if (root) return `/${root}/*`;
  return undefined;
}

// any method outside OpenTelemetry's known set is reported as _OTHER so scanner
// tokens cannot multiply span names
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/**
 * The server span for one HTTP request: only the route template is recorded,
 * never path, query, headers or body, since webhook routes may hold a secret
 * and data-plane paths carry data names.
 */
export function withHttpServerSpan(
  req: Request,
  handle: () => Response | Promise<Response>,
  options: ServerSpanOptions = {},
): Promise<Response> {
  const route = resolveHttpRoute(new URL(req.url).pathname);
  const method = KNOWN_METHODS.has(req.method) ? req.method : "_OTHER";
  const name = route ? `${method} ${route}` : method;
  const attributes: Record<string, string> = {
    "http.request.method": method,
  };
  if (method !== req.method) {
    attributes["http.request.method_original"] = req.method;
  }
  if (route) attributes["http.route"] = route;

  return withServerSpan(name, attributes, async (span) => {
    const response = await handle();
    span.setAttribute("http.response.status_code", response.status);
    if (response.status >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    return response;
  }, options);
}

/**
 * WebSocket upgrades pass untraced. Datastore routes open their span in
 * handleDatastoreRequest, once the caller is authenticated, so an
 * authenticated member's trace can be adopted.
 */
export function traceHttpRequests<A extends Deno.Addr = Deno.Addr>(
  handler: Deno.ServeHandler<A>,
): Deno.ServeHandler<A> {
  return (req, info) => {
    if (isWebSocketUpgrade(req)) return handler(req, info);
    if (matchDatastoreRoute(new URL(req.url).pathname) !== undefined) {
      return handler(req, info);
    }
    return withHttpServerSpan(req, () => handler(req, info));
  };
}
