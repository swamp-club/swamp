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
 * The routes of serve's datastore API (swamp-club#3915), apart from their
 * handler so the request tracer can name them without importing it.
 *
 * @module
 */

const ROUTE_PREFIX = "/api/v1/datastore/";

/** A datastore API route, with its path segments decoded. */
export type DatastoreRoute =
  | { readonly kind: "has"; readonly namespace: string }
  | {
    readonly kind: "chunk";
    readonly namespace: string;
    readonly sha256: string;
  }
  | {
    readonly kind: "commits";
    readonly namespace: string;
    readonly partition: string;
  }
  | { readonly kind: "changes"; readonly namespace: string }
  | { readonly kind: "base"; readonly namespace: string }
  | { readonly kind: "locks"; readonly namespace: string }
  | {
    readonly kind: "lease";
    readonly namespace: string;
    readonly leaseId: string;
  };

/**
 * The datastore route a path is, or undefined. Segments are decoded once:
 * a partition key's own `%2F` reaches the route as `%252F` and decodes to
 * the canonical key.
 */
export function matchDatastoreRoute(
  pathname: string,
): DatastoreRoute | undefined {
  if (!pathname.startsWith(ROUTE_PREFIX)) return undefined;
  let segments: string[];
  try {
    segments = pathname.slice(ROUTE_PREFIX.length).split("/").map(
      decodeURIComponent,
    );
  } catch {
    return undefined;
  }
  const [namespace, ...rest] = segments;
  if (namespace === undefined || namespace.length === 0) return undefined;
  if (rest.length === 2 && rest[0] === "chunks" && rest[1] === "has") {
    return { kind: "has", namespace };
  }
  if (rest.length === 2 && rest[0] === "chunks") {
    return { kind: "chunk", namespace, sha256: rest[1] };
  }
  if (rest.length === 3 && rest[0] === "partitions" && rest[2] === "commits") {
    return { kind: "commits", namespace, partition: rest[1] };
  }
  if (rest.length === 1 && rest[0] === "changes") {
    return { kind: "changes", namespace };
  }
  if (rest.length === 1 && rest[0] === "base") {
    return { kind: "base", namespace };
  }
  if (rest.length === 1 && rest[0] === "locks") {
    return { kind: "locks", namespace };
  }
  if (rest.length === 2 && rest[0] === "locks") {
    return { kind: "lease", namespace, leaseId: rest[1] };
  }
  return undefined;
}

/** The route template a datastore path is reported under in spans. */
export function datastoreRouteTemplate(route: DatastoreRoute): string {
  switch (route.kind) {
    case "has":
      return "/api/v1/datastore/{namespace}/chunks/has";
    case "chunk":
      return "/api/v1/datastore/{namespace}/chunks/{sha256}";
    case "commits":
      return "/api/v1/datastore/{namespace}/partitions/{partition}/commits";
    case "changes":
      return "/api/v1/datastore/{namespace}/changes";
    case "base":
      return "/api/v1/datastore/{namespace}/base";
    case "locks":
      return "/api/v1/datastore/{namespace}/locks";
    case "lease":
      return "/api/v1/datastore/{namespace}/locks/{leaseId}";
  }
}
