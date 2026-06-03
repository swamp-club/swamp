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

/**
 * Value object representing a pinned deno runtime version.
 *
 * Immutable, compared by value. Used to track which deno version
 * is embedded in the compiled binary and whether re-extraction is needed.
 */
export class DenoVersion {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  /**
   * Creates a DenoVersion from a version string (e.g., "2.6.5").
   *
   * @param version - Semver version string
   * @throws Error if version string is empty
   */
  static create(version: string): DenoVersion {
    const trimmed = version.trim();
    if (!trimmed) {
      throw new Error("DenoVersion cannot be empty");
    }
    return new DenoVersion(trimmed);
  }

  /**
   * Parses the version from `deno --version` output.
   * Extracts the version from the first line: "deno X.Y.Z (...)"
   */
  static fromVersionOutput(output: string): DenoVersion {
    const match = output.match(/^deno\s+(\S+)/);
    if (!match) {
      throw new Error(
        `Cannot parse deno version from output: ${output.slice(0, 100)}`,
      );
    }
    return DenoVersion.create(match[1]);
  }

  equals(other: DenoVersion): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
