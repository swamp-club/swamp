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

import { UserError } from "../errors.ts";

/**
 * never carries credentials, which Litestream resolves from the AWS SDK default
 * chain or Google ADC
 */
export type V3ReplicaTarget =
  | {
    readonly type: "s3";
    readonly bucket: string;
    readonly prefix: string;
    readonly region?: string;
    readonly endpoint?: string;
    /**
     * Path-style addressing. Unset, it is on whenever `endpoint` is set.
     */
    readonly forcePathStyle?: boolean;
  }
  | {
    readonly type: "gcs";
    readonly bucket: string;
    readonly prefix: string;
  };

const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  s3: ["type", "bucket", "prefix", "region", "endpoint", "forcePathStyle"],
  gcs: ["type", "bucket", "prefix"],
};

export function replicaTargetProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "it is not an object";
  }
  const record = value as Record<string, unknown>;
  // An own-key check: `type: "constructor"` must not find Object's.
  const allowed =
    typeof record.type === "string" && Object.hasOwn(ALLOWED_KEYS, record.type)
      ? ALLOWED_KEYS[record.type]
      : undefined;
  if (allowed === undefined) return '"type" must be "s3" or "gcs"';
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return `it carries "${key}", which a ${record.type} target may not; ` +
        "a replica target never carries credentials";
    }
  }
  const bucket = record.bucket;
  if (typeof bucket !== "string" || bucket === "" || bucket.includes("/")) {
    return '"bucket" must be a non-empty string without "/"';
  }
  const prefix = record.prefix;
  if (typeof prefix !== "string") return '"prefix" must be a string';
  if (prefix !== "") {
    const segments = prefix.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      return '"prefix" must have no leading, trailing or repeated "/", ' +
        'and no "." or ".." segment';
    }
  }
  if (record.type === "gcs") return undefined;
  if (
    record.region !== undefined &&
    (typeof record.region !== "string" || record.region === "")
  ) {
    return '"region" must be a non-empty string';
  }
  if (
    record.forcePathStyle !== undefined &&
    typeof record.forcePathStyle !== "boolean"
  ) {
    return '"forcePathStyle" must be a boolean';
  }
  if (record.endpoint !== undefined) {
    return endpointProblem(record.endpoint);
  }
  return undefined;
}

function endpointProblem(endpoint: unknown): string | undefined {
  if (typeof endpoint !== "string" || endpoint === "") {
    return '"endpoint" must be a non-empty string';
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return '"endpoint" must be a URL';
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return '"endpoint" must be an http or https URL';
  }
  if (url.username !== "" || url.password !== "") {
    return '"endpoint" must not carry credentials';
  }
  if (url.search !== "" || url.hash !== "") {
    return '"endpoint" must have no query or fragment';
  }
  return undefined;
}

export function parseV3ReplicaTarget(
  value: unknown,
  datastoreType: string,
): V3ReplicaTarget {
  // Validate and return one snapshot of the own fields, so a getter or a
  // provider that changes the object later cannot swap what was checked.
  const target = typeof value === "object" && value !== null &&
      !Array.isArray(value)
    ? { ...value }
    : value;
  const problem = replicaTargetProblem(target);
  if (problem !== undefined) {
    throw new UserError(
      `The ${datastoreType} datastore returned a replica target swamp cannot ` +
        `use: ${problem}. Update the datastore extension.`,
    );
  }
  return target as V3ReplicaTarget;
}
