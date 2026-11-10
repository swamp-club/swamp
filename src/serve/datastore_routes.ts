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

const ROUTE_PREFIX = "/api/v1/datastore/";

export type DatastoreRoute =
  | { readonly kind: "has"; readonly namespace: string }
  | {
    readonly kind: "chunk";
    readonly namespace: string;
    readonly sha256: string;
  }
  | { readonly kind: "batch"; readonly namespace: string }
  | {
    readonly kind: "commits";
    readonly namespace: string;
    readonly partition: string;
  }
  | { readonly kind: "changes"; readonly namespace: string }
  | { readonly kind: "authorize"; readonly namespace: string }
  | { readonly kind: "base"; readonly namespace: string }
  | { readonly kind: "locks"; readonly namespace: string }
  | {
    readonly kind: "lease";
    readonly namespace: string;
    readonly leaseId: string;
  }
  | {
    readonly kind: "lock-request";
    readonly namespace: string;
    readonly requestId: string;
  }
  | { readonly kind: "quarantine"; readonly namespace: string }
  | {
    readonly kind: "quarantine-accept";
    readonly namespace: string;
    readonly txnId: string;
  }
  | {
    readonly kind: "quarantine-discard";
    readonly namespace: string;
    readonly txnId: string;
  }
  | {
    readonly kind: "quarantine-change";
    readonly namespace: string;
    readonly txnId: string;
  };

/**
 * segments are decoded once: a partition key's own %2F reaches the route as
 * %252F and decodes to the canonical key
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
  if (rest.length === 1 && rest[0] === "commits") {
    return { kind: "batch", namespace };
  }
  if (rest.length === 1 && rest[0] === "changes") {
    return { kind: "changes", namespace };
  }
  if (rest.length === 1 && rest[0] === "authorize") {
    return { kind: "authorize", namespace };
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
  if (rest.length === 3 && rest[0] === "locks" && rest[1] === "requests") {
    return { kind: "lock-request", namespace, requestId: rest[2] };
  }
  if (rest.length === 1 && rest[0] === "quarantine") {
    return { kind: "quarantine", namespace };
  }
  if (rest.length === 2 && rest[0] === "quarantine") {
    return { kind: "quarantine-change", namespace, txnId: rest[1] };
  }
  if (
    rest.length === 3 && rest[0] === "quarantine" && rest[2] === "accept"
  ) {
    return { kind: "quarantine-accept", namespace, txnId: rest[1] };
  }
  if (
    rest.length === 3 && rest[0] === "quarantine" && rest[2] === "discard"
  ) {
    return { kind: "quarantine-discard", namespace, txnId: rest[1] };
  }
  return undefined;
}

export function datastoreRouteTemplate(route: DatastoreRoute): string {
  switch (route.kind) {
    case "has":
      return "/api/v1/datastore/{namespace}/chunks/has";
    case "chunk":
      return "/api/v1/datastore/{namespace}/chunks/{sha256}";
    case "batch":
      return "/api/v1/datastore/{namespace}/commits";
    case "commits":
      return "/api/v1/datastore/{namespace}/partitions/{partition}/commits";
    case "changes":
      return "/api/v1/datastore/{namespace}/changes";
    case "authorize":
      return "/api/v1/datastore/{namespace}/authorize";
    case "base":
      return "/api/v1/datastore/{namespace}/base";
    case "locks":
      return "/api/v1/datastore/{namespace}/locks";
    case "lease":
      return "/api/v1/datastore/{namespace}/locks/{leaseId}";
    case "lock-request":
      return "/api/v1/datastore/{namespace}/locks/requests/{requestId}";
    case "quarantine":
      return "/api/v1/datastore/{namespace}/quarantine";
    case "quarantine-accept":
      return "/api/v1/datastore/{namespace}/quarantine/{txnId}/accept";
    case "quarantine-discard":
      return "/api/v1/datastore/{namespace}/quarantine/{txnId}/discard";
    case "quarantine-change":
      return "/api/v1/datastore/{namespace}/quarantine/{txnId}";
  }
}
