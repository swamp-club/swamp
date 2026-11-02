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

import type { RepoMarkerData } from "./repo_marker_repository.ts";

export type DatastoreEnvReader = () => string | undefined;

const readDatastoreEnvDefault: DatastoreEnvReader = () =>
  Deno.env.get("SWAMP_DATASTORE");

/**
 * mirrors resolveDatastoreConfig precedence without resolving anything, except
 * it skips the cliArg tier
 */
export function effectiveDatastoreType(
  marker: RepoMarkerData | null,
  readDatastoreEnv: DatastoreEnvReader = readDatastoreEnvDefault,
): string {
  const envValue = readDatastoreEnv();
  if (envValue) {
    const colonIdx = envValue.indexOf(":");
    return colonIdx === -1 ? envValue : envValue.slice(0, colonIdx);
  }
  return marker?.datastore?.type ?? "filesystem";
}

export function isExtensionBackedDatastore(
  marker: RepoMarkerData | null,
  readDatastoreEnv: DatastoreEnvReader = readDatastoreEnvDefault,
): boolean {
  if (marker?.datastore?.managedConfig !== true) return false;
  return effectiveDatastoreType(marker, readDatastoreEnv) !== "filesystem";
}
