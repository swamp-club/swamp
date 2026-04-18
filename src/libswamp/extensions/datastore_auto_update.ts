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

/**
 * Tri-state outcome from the local-edits check. Produced by the caller-
 * supplied `detectLocalEdits` dep.
 *
 * - `match` — on-disk digest equals the stored anchor; safe to overwrite.
 * - `mismatch` — on-disk digest diverges from the anchor; user has edited
 *   something and auto-update must refuse.
 * - `no-anchor` — no stored anchor for this extension (pre-upgrade lockfile
 *   entry); grandfather path, proceed as before.
 */
export type LocalEditsStatus = "match" | "mismatch" | "no-anchor";

/**
 * Reason an auto-update attempt was skipped. Distinct from silent errors
 * (which continue to return null) — `skipped` signals a deliberate refusal
 * that callers surface visibly to the user. `local_edits` covers the
 * issue #126 refusal path.
 */
export type DatastoreAutoUpdateSkipReason = "local_edits";

/** Result of an auto-update attempt. */
export interface DatastoreAutoUpdateResult {
  updated: boolean;
  /**
   * Set when the update was intentionally refused. Present only on
   * deliberate refusals so callers can surface them visibly to the user.
   */
  skipped?: DatastoreAutoUpdateSkipReason;
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
  /**
   * Detect whether the on-disk per-extension subtree has been edited since
   * install. Optional: when omitted, the service behaves as before this
   * dep existed (no local-edits protection). Returns `no-anchor` for
   * lockfile entries that pre-date the filesChecksum field.
   */
  detectLocalEdits?: (name: string) => Promise<LocalEditsStatus>;
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

    // Local-edits check before the force-pull. Refuse silent overwrite of
    // user edits to the on-disk extension subtree (issue #126). Runs only
    // when detectLocalEdits is wired; callers without the dep get the
    // pre-fix behavior.
    if (deps.detectLocalEdits) {
      const editsStatus = await deps.detectLocalEdits(extensionName);
      if (editsStatus === "mismatch") {
        logger
          .debug`Refusing auto-update for ${extensionName}: local edits detected`;
        return {
          updated: false,
          skipped: "local_edits",
          previousVersion: installedVersion,
          newVersion: latestVersion,
        };
      }
      if (editsStatus === "no-anchor") {
        logger
          .debug`No stored anchor for ${extensionName}; grandfathering auto-update (anchor will be written on next install)`;
      }
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
