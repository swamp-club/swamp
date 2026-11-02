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

import { UserError } from "../errors.ts";

export class SwampVersion {
  private constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number,
    private readonly rawVersion: string,
  ) {}

  static create(version: string): SwampVersion {
    const trimmed = version.trim();
    if (trimmed.length === 0) {
      throw new UserError("Version cannot be empty");
    }

    // calver YYYYMMDD.HHMMSS.patch with an optional suffix; also matches the
    // dev format 0.0.0-dev
    const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/);
    if (!match) {
      throw new UserError(
        `Invalid version format: ${version}. Expected format: YYYYMMDD.HHMMSS.patch (e.g., "20260101.120000.0")`,
      );
    }

    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    const patch = parseInt(match[3], 10);

    const rawVersion = `${match[1]}.${match[2]}.${match[3]}`;
    return new SwampVersion(major, minor, patch, rawVersion);
  }

  equals(other: SwampVersion): boolean {
    return (
      this.major === other.major &&
      this.minor === other.minor &&
      this.patch === other.patch
    );
  }

  compareTo(other: SwampVersion): number {
    if (this.major !== other.major) {
      return this.major - other.major;
    }
    if (this.minor !== other.minor) {
      return this.minor - other.minor;
    }
    return this.patch - other.patch;
  }

  isNewerThan(other: SwampVersion): boolean {
    return this.compareTo(other) > 0;
  }

  isOlderThan(other: SwampVersion): boolean {
    return this.compareTo(other) < 0;
  }

  toString(): string {
    return this.rawVersion;
  }
}
