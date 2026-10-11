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
 * References to content stored as chunks (swamp-club#3233).
 *
 * @module
 */

import { RecordKey } from "./record_key.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True when `value` is a SHA-256 digest in lowercase hex. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** The serialized form of a {@link BlobRef}. */
export interface BlobRefJSON {
  readonly sha256: string;
  readonly size: number;
  readonly legacyKey?: string;
}

/**
 * Content too large to inline in a commit, addressed by its SHA-256. The
 * chunk store holds the bytes; a put op carries only this reference.
 * `legacyKey` names where a migrated blob still lives in a pre-v3 layout.
 */
export class BlobRef {
  private constructor(
    readonly sha256: string,
    readonly size: number,
    readonly legacyKey: RecordKey | undefined,
  ) {}

  /**
   * Throws when `sha256` is not 64 lowercase hex characters or `size` is not
   * a non-negative safe integer.
   */
  static create(props: {
    sha256: string;
    size: number;
    legacyKey?: RecordKey;
  }): BlobRef {
    if (!isSha256Hex(props.sha256)) {
      throw new Error(
        `Blob sha256 must be 64 lowercase hex characters: ${
          String(props.sha256)
        }`,
      );
    }
    if (!Number.isSafeInteger(props.size) || props.size < 0) {
      throw new Error(
        `Blob size must be a non-negative integer: ${String(props.size)}`,
      );
    }
    if (
      props.legacyKey !== undefined && !(props.legacyKey instanceof RecordKey)
    ) {
      throw new TypeError("Blob legacyKey must be a RecordKey");
    }
    return Object.freeze(
      new BlobRef(props.sha256, props.size, props.legacyKey),
    );
  }

  /** Parses the serialized form; the same rules as {@link BlobRef.create}. */
  static fromJSON(value: unknown): BlobRef {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Blob reference must be an object");
    }
    const json = value as Record<string, unknown>;
    for (const field of Object.keys(json)) {
      if (!["sha256", "size", "legacyKey"].includes(field)) {
        throw new Error(`A blob reference does not take the field '${field}'`);
      }
    }
    return BlobRef.create({
      sha256: json.sha256 as string,
      size: json.size as number,
      legacyKey: json.legacyKey === undefined
        ? undefined
        : RecordKey.fromJSON(json.legacyKey),
    });
  }

  toJSON(): BlobRefJSON {
    return this.legacyKey === undefined
      ? { sha256: this.sha256, size: this.size }
      : {
        sha256: this.sha256,
        size: this.size,
        legacyKey: this.legacyKey.toString(),
      };
  }

  equals(other: BlobRef): boolean {
    return this.sha256 === other.sha256 && this.size === other.size &&
      (this.legacyKey === undefined
        ? other.legacyKey === undefined
        : other.legacyKey !== undefined &&
          this.legacyKey.equals(other.legacyKey));
  }
}
