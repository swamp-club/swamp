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

import { CHECK_INTERVAL_MS } from "../update/update_check_cache.ts";

export interface ExtensionUpdateCheckEntry {
  checkedAt: string;
  latestVersion: string;
}

/**
 * for S3-backed datastores this file syncs to the remote, so machines sharing
 * the datastore share the cooldown and avoid redundant registry checks
 */
export type ExtensionUpdateCheckMap = Record<string, ExtensionUpdateCheckEntry>;

export interface ExtensionUpdateCheckRepository {
  read(): Promise<ExtensionUpdateCheckMap>;
  write(data: ExtensionUpdateCheckMap): Promise<void>;
}

/** a stable or absent channel uses the bare name for backward compatibility */
export function extensionCacheKey(
  extensionName: string,
  channel?: string,
): string {
  if (channel && channel !== "stable") {
    return `${extensionName}:${channel}`;
  }
  return extensionName;
}

export function isExtensionCheckStale(
  cache: ExtensionUpdateCheckMap,
  extensionName: string,
  now: Date,
  channel?: string,
): boolean {
  const key = extensionCacheKey(extensionName, channel);
  const entry = cache[key];
  if (!entry) return true;

  const checkedAt = new Date(entry.checkedAt);
  if (isNaN(checkedAt.getTime())) return true;

  return now.getTime() - checkedAt.getTime() >= CHECK_INTERVAL_MS;
}
