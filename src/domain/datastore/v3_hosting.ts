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

import type { DatastoreProvider } from "./datastore_provider.ts";
import { UserError } from "../errors.ts";

/**
 * the first release that keeps v2 file sync off a v3 bucket and refuses a
 * format-3 marker for a swamp too old to read it, so a v3 bucket repo pins an
 * extension with that guard from the start
 */
export const V3_BUCKET_MIN_EXTENSION_VERSION = "2026.10.16.5";

export const V3_HOSTING_UNSUPPORTED_CODE = "datastore_v3_hosting_unsupported";

export type V3HostingCapabilities = Pick<
  DatastoreProvider,
  | "datastoreWideLease"
  | "datastoreControlPlaneStore"
  | "storage"
  | "replicaTarget"
  | "replicaPaths"
>;

/** only the literal true declares datastoreWideLease */
export function missingV3Capabilities(
  provider: V3HostingCapabilities,
): string[] {
  const missing: string[] = [];
  if (provider.datastoreWideLease !== true) missing.push("datastoreWideLease");
  if (typeof provider.datastoreControlPlaneStore !== "function") {
    missing.push("datastoreControlPlaneStore()");
  }
  if (typeof provider.storage !== "function") missing.push("storage()");
  if (typeof provider.replicaTarget !== "function") {
    missing.push("replicaTarget()");
  }
  if (typeof provider.replicaPaths !== "function") {
    missing.push("replicaPaths()");
  }
  return missing;
}

export class V3HostingUnsupportedError extends UserError {
  readonly datastoreType: string;
  readonly missing: readonly string[];

  constructor(datastoreType: string, missing: readonly string[]) {
    super(
      `The ${datastoreType} datastore cannot host a v3 datastore: its ` +
        `extension does not declare ${missing.join(", ")}. v3 on S3 and GCS ` +
        `needs @swamp/s3-datastore or @swamp/gcs-datastore ` +
        `${V3_BUCKET_MIN_EXTENSION_VERSION} or later: run \`swamp extension ` +
        `update ${datastoreType}\` to update it. Nothing was changed.`,
      V3_HOSTING_UNSUPPORTED_CODE,
    );
    this.name = "V3HostingUnsupportedError";
    this.datastoreType = datastoreType;
    this.missing = missing;
  }
}

export const V3_EXTENSION_TOO_OLD_CODE = "datastore_v3_extension_too_old";

export class V3BucketExtensionTooOldError extends UserError {
  readonly datastoreType: string;
  readonly version: string;

  constructor(
    datastoreType: string,
    version: string,
    where: string,
    extensionName: string = datastoreType,
  ) {
    super(
      `The ${datastoreType} datastore cannot host a v3 datastore: ${where} ` +
        `${version}, and v3 on S3 and GCS needs ` +
        `${V3_BUCKET_MIN_EXTENSION_VERSION} or later. Run \`swamp extension ` +
        `update ${extensionName}\` to update it. Nothing was changed.`,
      V3_EXTENSION_TOO_OLD_CODE,
    );
    this.name = "V3BucketExtensionTooOldError";
    this.datastoreType = datastoreType;
    this.version = version;
  }
}

export function assertV3Hosting(
  provider: V3HostingCapabilities,
  datastoreType: string,
): void {
  const missing = missingV3Capabilities(provider);
  if (missing.length > 0) {
    throw new V3HostingUnsupportedError(datastoreType, missing);
  }
}
