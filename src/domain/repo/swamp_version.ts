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

import { UserError } from "../errors.ts";

/**
 * SwampVersion is a value object representing a semantic version string.
 *
 * Used to track the version of swamp that initialized or upgraded a repository.
 */
export class SwampVersion {
  private constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number,
  ) {}

  /**
   * Creates a SwampVersion from a version string.
   *
   * @param version - The version string (e.g., "0.1.0", "1.2.3")
   * @returns A new SwampVersion instance
   * @throws Error if the version string is invalid
   */
  static create(version: string): SwampVersion {
    const trimmed = version.trim();
    if (trimmed.length === 0) {
      throw new UserError("Version cannot be empty");
    }

    // Match calver format: YYYYMMDD.HHMMSS.patch with optional suffix
    // Also matches dev format: 0.0.0-dev
    // Examples: "20260204.202125.0", "20260204.202125.0-sha.abc123", "0.0.0-dev"
    const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/);
    if (!match) {
      throw new UserError(
        `Invalid version format: ${version}. Expected format: YYYYMMDD.HHMMSS.patch (e.g., "20260101.120000.0")`,
      );
    }

    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    const patch = parseInt(match[3], 10);

    return new SwampVersion(major, minor, patch);
  }

  /**
   * Checks equality with another SwampVersion.
   */
  equals(other: SwampVersion): boolean {
    return (
      this.major === other.major &&
      this.minor === other.minor &&
      this.patch === other.patch
    );
  }

  /**
   * Compares this version to another.
   * Returns negative if this < other, zero if equal, positive if this > other.
   */
  compareTo(other: SwampVersion): number {
    if (this.major !== other.major) {
      return this.major - other.major;
    }
    if (this.minor !== other.minor) {
      return this.minor - other.minor;
    }
    return this.patch - other.patch;
  }

  /**
   * Returns true if this version is newer than the other.
   */
  isNewerThan(other: SwampVersion): boolean {
    return this.compareTo(other) > 0;
  }

  /**
   * Returns true if this version is older than the other.
   */
  isOlderThan(other: SwampVersion): boolean {
    return this.compareTo(other) < 0;
  }

  /**
   * Returns the version as a string (e.g., "1.0.0").
   */
  toString(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }
}
