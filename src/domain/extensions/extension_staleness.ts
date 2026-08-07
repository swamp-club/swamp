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

import { CalVer } from "../models/calver.ts";
import { extensionCacheKey } from "./extension_update_check_cache.ts";
import type { ExtensionUpdateCheckMap } from "./extension_update_check_cache.ts";

export interface InstalledExtensionEntry {
  readonly version: string;
  readonly channel?: string;
}

export interface StaleExtension {
  readonly name: string;
  readonly installedVersion: string;
  readonly latestVersion: string;
  readonly daysBehind: number;
}

const DEFAULT_STALENESS_THRESHOLD_DAYS = 14;

export function findStaleExtensions(
  lockfile: Record<string, InstalledExtensionEntry>,
  cache: ExtensionUpdateCheckMap,
  thresholdDays: number = DEFAULT_STALENESS_THRESHOLD_DAYS,
): StaleExtension[] {
  const stale: StaleExtension[] = [];

  for (const [name, entry] of Object.entries(lockfile)) {
    const key = extensionCacheKey(name, entry.channel);
    const cached = cache[key];
    if (!cached) continue;

    if (
      !CalVer.isValid(entry.version) || !CalVer.isValid(cached.latestVersion)
    ) {
      continue;
    }

    const installed = CalVer.create(entry.version);
    const latest = CalVer.create(cached.latestVersion);
    const daysBehind = CalVer.daysBehind(installed, latest);

    if (daysBehind >= thresholdDays) {
      stale.push({
        name,
        installedVersion: entry.version,
        latestVersion: cached.latestVersion,
        daysBehind,
      });
    }
  }

  stale.sort((a, b) => b.daysBehind - a.daysBehind);
  return stale;
}

export function formatStalenessWarning(stale: StaleExtension[]): string {
  const details = stale.map((s) =>
    `${s.name} (${s.daysBehind}d behind, ${s.installedVersion} → ${s.latestVersion})`
  ).join(", ");
  return `${stale.length} pulled extension(s) are outdated: ${details}. Run 'swamp extension pull' to update.`;
}
