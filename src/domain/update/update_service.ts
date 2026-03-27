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
import { validateRedirectUrl } from "./integrity.ts";
import { UserError } from "../errors.ts";

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
   * Fetch the expected SHA-256 checksum for a tarball.
   * Derives the checksum URL from the tarball URL by appending ".sha256".
   */
  fetchChecksum(tarballUrl: string): Promise<string>;

  /**
   * Download the tarball, verify its SHA-256 checksum, extract, and install.
   * Throws UserError if checksum verification fails.
   */
  downloadAndInstall(
    url: string,
    binaryPath: string,
    expectedChecksum: string,
  ): Promise<void>;
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

    validateRedirectUrl(redirectUrl);

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
   * Check whether the process can write to the binary path.
   * Throws a UserError with remediation advice if not.
   */
  async checkWritePermission(): Promise<void> {
    try {
      // Try opening the file for writing without truncating — this tests
      // actual write permission without modifying the file.
      const file = await Deno.open(this.binaryPath, { write: true });
      file.close();
    } catch (error) {
      if (error instanceof Deno.errors.PermissionDenied) {
        throw new UserError(
          `Cannot update ${this.binaryPath}: permission denied. Re-run with: sudo swamp update`,
        );
      }
      // Other errors (e.g. NotFound) are fine — the file may not exist yet
    }
  }

  /**
   * Check for and install an update.
   * Downloads from the resolved versioned URL, not the stable redirect pointer.
   */
  async update(platform: Platform): Promise<UpdateResult> {
    await this.checkWritePermission();

    const redirectUrl = await this.checker.checkForUpdate(platform);
    if (!redirectUrl) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    validateRedirectUrl(redirectUrl);

    const latestVersion = parseVersionFromRedirectUrl(redirectUrl);
    if (!latestVersion || latestVersion === this.currentVersion) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    const expectedChecksum = await this.checker.fetchChecksum(redirectUrl);
    await this.checker.downloadAndInstall(
      redirectUrl,
      this.binaryPath,
      expectedChecksum,
    );

    return {
      status: "updated",
      previousVersion: this.currentVersion,
      newVersion: latestVersion,
      warning: this.devBuildWarning(),
    };
  }
}
