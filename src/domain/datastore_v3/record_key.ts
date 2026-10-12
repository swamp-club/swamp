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
 * The path a v3 record projects to (swamp-club#3233).
 *
 * @module
 */

/** The longest record key accepted, in UTF-16 code units. */
export const MAX_RECORD_KEY_LENGTH = 4096;

/**
 * Where a record lands when it is materialised as a real file: a path
 * relative to the namespace, with forward slashes, in today's cache layout
 * (e.g. `data/aws-ec2/<id>/vpc/7/raw`), so every consumer that reads real
 * paths keeps working.
 *
 * A record key is a projection detail. The partition aggregate never parses
 * it: what an op means comes from its intent and metadata, never from where
 * it lands.
 */
export class RecordKey {
  private constructor(private readonly value: string) {}

  /**
   * Throws for an empty or overlong key, an absolute path, a backslash or
   * NUL, an empty segment (`a//b`, a trailing slash), or a `.` or `..`
   * segment.
   */
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

  /** Parses the serialized form; the same rules as {@link RecordKey.create}. */
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
