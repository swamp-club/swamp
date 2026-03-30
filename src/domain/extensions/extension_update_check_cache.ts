// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { CHECK_INTERVAL_MS } from "../update/update_check_cache.ts";

/** Cached update check result for a single extension. */
export interface ExtensionUpdateCheckEntry {
  checkedAt: string; // ISO 8601
  latestVersion: string;
}

/**
 * Map of extension name → last update check result.
 *
 * Stored in .swamp/extension-update-checks.json. For S3-backed datastores
 * this file is synced to the remote, so all machines sharing the datastore
 * share the 24h cooldown — avoiding redundant registry checks.
 */
export type ExtensionUpdateCheckMap = Record<string, ExtensionUpdateCheckEntry>;

/** Port for reading/writing per-extension update check cache. */
export interface ExtensionUpdateCheckRepository {
  read(): Promise<ExtensionUpdateCheckMap>;
  write(data: ExtensionUpdateCheckMap): Promise<void>;
}

/**
 * Returns true if the cache entry for the given extension is stale
 * (older than 24 hours) or does not exist.
 */
export function isExtensionCheckStale(
  cache: ExtensionUpdateCheckMap,
  extensionName: string,
  now: Date,
): boolean {
  const entry = cache[extensionName];
  if (!entry) return true;

  const checkedAt = new Date(entry.checkedAt);
  if (isNaN(checkedAt.getTime())) return true;

  return now.getTime() - checkedAt.getTime() >= CHECK_INTERVAL_MS;
}
