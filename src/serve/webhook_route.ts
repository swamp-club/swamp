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

export const WEBHOOK_ROUTE_PREFIX = "/hooks/";

// Serve answers "/" and paths under these first segments only, and never adds a
// route under WEBHOOK_ROUTE_PREFIX; serve_webhook_route_rules_test holds it to that.
export const SERVE_RESERVED_ROOTS: readonly string[] = [
  "health",
  "ready",
  "auth",
  "api",
  "internal",
  "dashboard",
  "data",
  "bundle",
];

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// The first non-empty segment, as the data plane routes: //data/x is its path.
function reservedRootOf(path: string): string | undefined {
  const first = path.split("/").find((segment) => segment.length > 0);
  if (first === undefined) return "/";
  for (const candidate of [first, decodeSegment(first)]) {
    if (SERVE_RESERVED_ROOTS.includes(candidate)) return `/${candidate}`;
  }
  return undefined;
}

export function isReservedServePath(path: string): boolean {
  return reservedRootOf(path) !== undefined;
}

/** why serve will not serve a webhook route, or undefined when it will */
export function webhookRouteProblem(route: string): string | undefined {
  if (!route.startsWith("/")) return "does not start with '/'";
  const dotSegment = route.split("/").some((segment) => {
    const decoded = decodeSegment(segment);
    return decoded === "." || decoded === "..";
  });
  if (dotSegment) {
    return "has a '.' or '..' segment, which no request path can match";
  }
  const root = reservedRootOf(route);
  if (root !== undefined) {
    return `is under '${root}', which serve reserves for its own API; use a ` +
      `route under ${WEBHOOK_ROUTE_PREFIX} instead`;
  }
  return undefined;
}

export function skippedWebhookMessage(route: string, reason: string): string {
  return `Skipped webhook route '${route}': it ${reason}`;
}

export interface RouteCheck<T> {
  readonly allowed: T[];
  readonly refused: { readonly item: T; readonly reason: string }[];
}

export function partitionWebhookRoutes<T extends { readonly route: string }>(
  items: readonly T[],
): RouteCheck<T> {
  const allowed: T[] = [];
  const refused: { item: T; reason: string }[] = [];
  for (const item of items) {
    const reason = webhookRouteProblem(item.route);
    if (reason === undefined) allowed.push(item);
    else refused.push({ item, reason });
  }
  return { allowed, refused };
}
