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

export const MAX_RECORD_KEY_LENGTH = 4096;

/**
 * the partition aggregate never parses a key; what an op means comes from its
 * intent and metadata, never from where it lands
 */
export class RecordKey {
  private constructor(private readonly value: string) {}

  static create(value: string): RecordKey {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("Record key must be a non-empty string");
    }
    if (value.length > MAX_RECORD_KEY_LENGTH) {
      throw new Error(
        `Record key is longer than ${MAX_RECORD_KEY_LENGTH} characters`,
      );
    }
    if (value.includes("\\") || value.includes("\0")) {
      throw new Error(
        `Record key must not contain a backslash or NUL: ${value}`,
      );
    }
    for (const segment of value.split("/")) {
      if (segment === "" || segment === "." || segment === "..") {
        throw new Error(
          `Record key must be a relative path without empty, '.' or '..' segments: ${value}`,
        );
      }
    }
    return new RecordKey(value);
  }

  static fromJSON(value: unknown): RecordKey {
    if (typeof value !== "string") {
      throw new TypeError("Record key must be a string");
    }
    return RecordKey.create(value);
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }

  equals(other: RecordKey): boolean {
    return this.value === other.value;
  }
}
