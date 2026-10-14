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
 * The replica a v3 writer's Litestream sidecar replicates to (swamp-club#3416).
 *
 * Phase 4 D1 ships the sidecar dormant: nothing replicates unless the
 * internal, undocumented `SWAMP_V3_REPLICA` variable names a replica, which
 * only tests set. Phase 4E replaces it with the datastore's own bucket. This
 * module is its only reader.
 *
 * @module
 */

import { UserError } from "../../../domain/errors.ts";

/** The internal variable that turns replication on, for tests only. */
export const V3_REPLICA_ENV = "SWAMP_V3_REPLICA";

/** Where Litestream replicates `commits.db`. */
export type V3ReplicaSetting =
  | { readonly type: "file"; readonly path: string }
  | {
    readonly type: "s3";
    readonly bucket: string;
    readonly path: string;
    readonly endpoint?: string;
    readonly region?: string;
  };

/**
 * The replica `SWAMP_V3_REPLICA` names, or undefined when it is unset, which
 * is every real user's case: no sidecar, no replication.
 *
 * @throws UserError when it is set but not a replica
 */
export function v3ReplicaSetting(): V3ReplicaSetting | undefined {
  const raw = Deno.env.get(V3_REPLICA_ENV);
  if (raw === undefined || raw === "") return undefined;
  return parseV3ReplicaSetting(raw);
}

/** Parses a `SWAMP_V3_REPLICA` value. */
export function parseV3ReplicaSetting(raw: string): V3ReplicaSetting {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid("it is not JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw invalid("it is not an object");
  }
  const record = value as Record<string, unknown>;
  const text = (key: string, required: boolean): string | undefined => {
    const field = record[key];
    if (field === undefined && !required) return undefined;
    if (typeof field !== "string" || field === "") {
      throw invalid(`"${key}" must be a non-empty string`);
    }
    return field;
  };
  if (record.type === "file") {
    return { type: "file", path: text("path", true)! };
  }
  if (record.type === "s3") {
    const endpoint = text("endpoint", false);
    const region = text("region", false);
    return {
      type: "s3",
      bucket: text("bucket", true)!,
      path: text("path", true)!,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(region !== undefined ? { region } : {}),
    };
  }
  throw invalid('"type" must be "file" or "s3"');
}

/**
 * The replica's identity, which a lineage records: a lineage continues only
 * under the same root.
 */
export function replicaRootOf(setting: V3ReplicaSetting): string {
  return setting.type === "file"
    ? `file:${setting.path}`
    : `s3:${setting.endpoint ?? ""}:${setting.bucket}:${setting.path}`;
}

function invalid(reason: string): UserError {
  return new UserError(
    `${V3_REPLICA_ENV} does not name a replica: ${reason}. It is an internal ` +
      `setting for tests; unset it.`,
  );
}
