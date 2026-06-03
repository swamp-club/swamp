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

import type { Platform } from "./platform.ts";
import type { UpdateCheckCacheRepository } from "./update_check_cache.ts";
import { isCacheStale } from "./update_check_cache.ts";
import type { UpdateChecker } from "./update_service.ts";
import { isDevBuild, parseVersionFromRedirectUrl } from "./update_service.ts";
import {
  getVersionAgeDays,
  isVersionStale,
  VERSION_STALENESS_THRESHOLD_DAYS,
} from "./version_staleness.ts";

export type UpdateNotification =
  | {
    type: "update_available";
    currentVersion: string;
    latestVersion: string;
  }
  | {
    type: "version_stale";
    currentVersion: string;
    versionAgeDays: number;
  };

/**
 * Domain service for proactive update notifications.
 *
 * Reads the local cache to determine if a notification should be shown,
 * and fires a background check to refresh the cache when stale.
 */
export class UpdateNotificationService {
  private readonly currentVersion: string;
  private readonly cacheRepository: UpdateCheckCacheRepository;
  private readonly checker: UpdateChecker;

  constructor(
    currentVersion: string,
    cacheRepository: UpdateCheckCacheRepository,
    checker: UpdateChecker,
  ) {
    this.currentVersion = currentVersion;
    this.cacheRepository = cacheRepository;
    this.checker = checker;
  }

  /**
   * Determines if a notification should be shown to the user.
   * Only reads local state (cache file + version string), no network I/O.
   */
  async getNotification(): Promise<UpdateNotification | null> {
    // Dev builds never show notifications
    if (isDevBuild(this.currentVersion)) return null;

    // Check if the current version is very old
    const now = new Date();
    if (
      isVersionStale(this.currentVersion, now, VERSION_STALENESS_THRESHOLD_DAYS)
    ) {
      const ageDays = getVersionAgeDays(this.currentVersion, now);
      if (ageDays !== null) {
        return {
          type: "version_stale",
          currentVersion: this.currentVersion,
          versionAgeDays: ageDays,
        };
      }
    }

    // Check cache for a known newer version.
    // Use lexicographic comparison: CalVer versions (YYYYMMDD.HHMMSS.patch-sha.hash)
    // are naturally sortable, so "greater than" means "newer than".
    const cache = await this.cacheRepository.read();
    if (cache && cache.latestVersion > this.currentVersion) {
      return {
        type: "update_available",
        currentVersion: this.currentVersion,
        latestVersion: cache.latestVersion,
      };
    }

    return null;
  }

  /**
   * Fire-and-forget: refreshes the cache if stale.
   * Issues an HTTP HEAD check and writes the result. Never throws.
   */
  backgroundCheck(platform: Platform): void {
    (async () => {
      const cache = await this.cacheRepository.read();
      const now = new Date();

      if (!isCacheStale(cache, now)) return;

      let latestVersion: string | undefined;
      try {
        const redirectUrl = await this.checker.checkForUpdate(platform);
        if (redirectUrl) {
          latestVersion = parseVersionFromRedirectUrl(redirectUrl) ??
            undefined;
        }
      } catch {
        // Network failure — fall through to write a timestamp-only cache
        // entry so we respect the 24h cooldown even when offline.
      }

      await this.cacheRepository.write({
        latestVersion: latestVersion ?? cache?.latestVersion ??
          this.currentVersion,
        checkedAt: now.toISOString(),
      });
    })().catch(() => {
      // Silently ignore all errors — never break the CLI for update checks
    });
  }
}
