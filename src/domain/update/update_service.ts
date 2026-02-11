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

import type { Platform } from "./platform.ts";

/**
 * Port for checking and performing updates.
 * Implemented by infrastructure adapters (e.g. HttpUpdateChecker).
 */
export interface UpdateChecker {
  /**
   * Check the latest available version by inspecting the stable URL redirect.
   * Returns the redirect URL containing the version, or null if no redirect.
   */
  checkForUpdate(platform: Platform): Promise<string | null>;

  /**
   * Download and install a binary from the given URL to the target path.
   */
  downloadAndInstall(url: string, binaryPath: string): Promise<void>;
}

/**
 * Discriminated union for update results.
 */
export type UpdateResult =
  | { status: "up_to_date"; currentVersion: string; warning?: string }
  | {
    status: "update_available";
    currentVersion: string;
    latestVersion: string;
    warning?: string;
  }
  | {
    status: "updated";
    previousVersion: string;
    newVersion: string;
    warning?: string;
  };

/**
 * Returns true when the version is a development build.
 * Dev builds have an empty sha (e.g. "20260206.200442.0-sha.") or lack the "-sha." segment entirely.
 */
export function isDevBuild(version: string): boolean {
  const shaIndex = version.indexOf("-sha.");
  if (shaIndex === -1) {
    return true;
  }
  const shaValue = version.substring(shaIndex + 5);
  return shaValue.length === 0;
}

/**
 * Extract a CalVer version string from a redirect URL.
 * Expected URL pattern: .../swamp/{version}/binary/...
 * Returns null if the pattern doesn't match.
 */
export function parseVersionFromRedirectUrl(url: string): string | null {
  const match = url.match(/\/swamp\/([^/]+)\/binary\//);
  return match ? match[1] : null;
}

/**
 * Domain service for self-update operations.
 */
export class UpdateService {
  private readonly checker: UpdateChecker;
  private readonly currentVersion: string;
  private readonly binaryPath: string;

  constructor(
    checker: UpdateChecker,
    currentVersion: string,
    binaryPath: string,
  ) {
    this.checker = checker;
    this.currentVersion = currentVersion;
    this.binaryPath = binaryPath;
  }

  private devBuildWarning(): string | undefined {
    if (isDevBuild(this.currentVersion)) {
      return "Replacing a development build with a release build. Run `deno run compile` to restore a dev build.";
    }
    return undefined;
  }

  /**
   * Check whether an update is available without installing.
   */
  async check(platform: Platform): Promise<UpdateResult> {
    const redirectUrl = await this.checker.checkForUpdate(platform);
    if (!redirectUrl) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    const latestVersion = parseVersionFromRedirectUrl(redirectUrl);
    if (!latestVersion || latestVersion === this.currentVersion) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    return {
      status: "update_available",
      currentVersion: this.currentVersion,
      latestVersion,
      warning: this.devBuildWarning(),
    };
  }

  /**
   * Check for and install an update.
   * Downloads from the resolved versioned URL, not the stable redirect pointer.
   */
  async update(platform: Platform): Promise<UpdateResult> {
    const redirectUrl = await this.checker.checkForUpdate(platform);
    if (!redirectUrl) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    const latestVersion = parseVersionFromRedirectUrl(redirectUrl);
    if (!latestVersion || latestVersion === this.currentVersion) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    await this.checker.downloadAndInstall(redirectUrl, this.binaryPath);

    return {
      status: "updated",
      previousVersion: this.currentVersion,
      newVersion: latestVersion,
      warning: this.devBuildWarning(),
    };
  }
}
