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
 * Whether an extension datastore can host a v3 datastore (swamp-club#3534,
 * Phase 4E): what its provider must declare before `swamp datastore setup
 * --format 3` creates one on it, and before a command opens one.
 *
 * @module
 */

import type { DatastoreProvider } from "./datastore_provider.ts";
import { UserError } from "../errors.ts";

/**
 * The `@swamp/s3-datastore` and `@swamp/gcs-datastore` release a v3 bucket
 * datastore needs. 2026.10.16.1 first declared every capability v3 uses
 * (`replicaTarget()` and `replicaPaths()`, swamp-club#3508); 2026.10.16.5
 * also keeps its v2 file sync off a v3 bucket, refusing a format-3 marker
 * for a swamp too old to read it (swamp-club#3549), so a v3 bucket repo
 * pins an extension with that guard from the start.
 */
export const V3_BUCKET_MIN_EXTENSION_VERSION = "2026.10.16.5";

/** Error code for a datastore whose provider cannot host v3. */
export const V3_HOSTING_UNSUPPORTED_CODE = "datastore_v3_hosting_unsupported";

/** The provider members a v3 datastore needs. */
export type V3HostingCapabilities = Pick<
  DatastoreProvider,
  | "datastoreWideLease"
  | "datastoreControlPlaneStore"
  | "storage"
  | "replicaTarget"
  | "replicaPaths"
>;

/**
 * The capabilities `provider` lacks to host a v3 datastore, in a fixed
 * order, or an empty list when it has them all. Only the literal `true`
 * declares `datastoreWideLease`.
 */
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

/** Thrown when a datastore's provider cannot host a v3 datastore. */
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

/** Error code for a v3 bucket datastore whose extension is too old. */
export const V3_EXTENSION_TOO_OLD_CODE = "datastore_v3_extension_too_old";

/**
 * Thrown when a v3 bucket datastore's extension, as loaded or as pinned in
 * the repo's lockfile, is older than {@link V3_BUCKET_MIN_EXTENSION_VERSION}
 * (swamp-club#3567).
 */
export class V3BucketExtensionTooOldError extends UserError {
  readonly datastoreType: string;
  readonly version: string;

  /**
   * @param extensionName - the extension that ships the type, named in the
   *   update command; the type itself when unknown
   */
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

/**
 * Throws unless `provider` declares every capability a v3 datastore needs.
 *
 * @throws V3HostingUnsupportedError naming what is missing
 */
export function assertV3Hosting(
  provider: V3HostingCapabilities,
  datastoreType: string,
): void {
  const missing = missingV3Capabilities(provider);
  if (missing.length > 0) {
    throw new V3HostingUnsupportedError(datastoreType, missing);
  }
}
