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

import { getLogger } from "@logtape/logtape";
import {
  type ExtensionUpdateCheckRepository,
  isExtensionCheckStale,
} from "../../domain/extensions/extension_update_check_cache.ts";
import { checkExtensionVersion } from "../../domain/extensions/extension_update_service.ts";

const logger = getLogger(["swamp", "extensions", "auto-update"]);

/** Result of an auto-update attempt. */
export interface DatastoreAutoUpdateResult {
  updated: boolean;
  previousVersion?: string;
  newVersion?: string;
}

/** Dependencies for the auto-update check. */
export interface DatastoreAutoUpdateDeps {
  /** Get the installed version of an extension, or null if not installed. */
  getInstalledVersion: (name: string) => Promise<string | null>;
  /** Get the latest version from the registry, or null on error. */
  getLatestVersion: (name: string) => Promise<string | null>;
  /** Pull and hot-reload the extension to the given version. */
  pullExtension: (name: string, version: string) => Promise<void>;
  /** Cache repository for per-extension update check timestamps. */
  cacheRepository: ExtensionUpdateCheckRepository;
}

const SWAMP_COLLECTIVE = "@swamp/";

/**
 * Checks if a @swamp/ datastore extension needs updating and auto-pulls
 * if a newer version is available.
 *
 * Only triggers for @swamp/ collective extensions. Uses a 24h cache
 * cooldown to avoid checking the registry on every command.
 *
 * Never throws — all errors are caught and logged. Returns null if
 * the check was skipped (not @swamp/, cache fresh, etc.).
 */
export async function maybeAutoUpdateDatastoreExtension(
  extensionName: string,
  deps: DatastoreAutoUpdateDeps,
): Promise<DatastoreAutoUpdateResult | null> {
  try {
    // Only auto-update @swamp/ extensions
    if (!extensionName.startsWith(SWAMP_COLLECTIVE)) {
      return null;
    }

    // Check cache staleness
    const cache = await deps.cacheRepository.read();
    const now = new Date();
    if (!isExtensionCheckStale(cache, extensionName, now)) {
      return null;
    }

    // Get installed version
    const installedVersion = await deps.getInstalledVersion(extensionName);
    if (!installedVersion) {
      logger
        .debug`No installed version found for ${extensionName}, skipping auto-update`;
      return null;
    }

    logger
      .debug`Checking ${extensionName} for updates (installed: ${installedVersion})`;

    // Query registry
    const latestVersion = await deps.getLatestVersion(extensionName);
    if (!latestVersion) {
      logger.debug`Registry returned no version for ${extensionName}`;
      // Registry unreachable — update cache to avoid retrying immediately
      cache[extensionName] = {
        checkedAt: now.toISOString(),
        latestVersion: installedVersion,
      };
      await deps.cacheRepository.write(cache);
      return null;
    }

    // Compare versions
    const status = checkExtensionVersion(
      extensionName,
      installedVersion,
      latestVersion,
    );

    // Update cache regardless of result
    cache[extensionName] = {
      checkedAt: now.toISOString(),
      latestVersion,
    };
    await deps.cacheRepository.write(cache);

    if (status.status !== "update_available") {
      return { updated: false };
    }

    // Pull the new version
    logger.info(
      "Updating {name} {from} → {to}",
      { name: extensionName, from: installedVersion, to: latestVersion },
    );
    await deps.pullExtension(extensionName, latestVersion);

    return {
      updated: true,
      previousVersion: installedVersion,
      newVersion: latestVersion,
    };
  } catch (error) {
    logger.debug`Auto-update check failed for ${extensionName}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return null;
  }
}
