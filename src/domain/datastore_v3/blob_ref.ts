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

/** One chunk of content stored as several, in order. */
export interface BlobPart {
  readonly sha256: string;
  readonly size: number;
}

/** The serialized form of a {@link BlobRef}. */
export interface BlobRefJSON {
  readonly sha256: string;
  readonly size: number;
  readonly parts?: readonly BlobPart[];
  readonly legacyKey?: string;
}

/**
 * Content too large to inline in a commit, addressed by its SHA-256. The
 * chunk store holds the bytes; a put op carries only this reference.
 * `sha256` is always the digest of the whole content. Content stored as one
 * chunk has no `parts`, and that chunk's key is `sha256`; content stored as
 * several lists them in `parts`, in order (swamp-club#3237).
 * `legacyKey` names where a migrated blob still lives in a pre-v3 layout.
 */
export class BlobRef {
  private constructor(
    readonly sha256: string,
    readonly size: number,
    readonly parts: readonly BlobPart[] | undefined,
    readonly legacyKey: RecordKey | undefined,
  ) {}

  /**
   * Throws when `sha256` is not 64 lowercase hex characters or `size` is not
   * a non-negative safe integer, or when `parts` is given with fewer than
   * two parts, a malformed part digest, a part size that is not a positive
   * safe integer, or part sizes that do not add up to `size`.
   */
  static create(props: {
    sha256: string;
    size: number;
    parts?: readonly BlobPart[];
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
    const parts = props.parts === undefined
      ? undefined
      : readParts(props.parts, props.size);
    return Object.freeze(
      new BlobRef(props.sha256, props.size, parts, props.legacyKey),
    );
  }

  /** Parses the serialized form; the same rules as {@link BlobRef.create}. */
  static fromJSON(value: unknown): BlobRef {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Blob reference must be an object");
    }
    const json = value as Record<string, unknown>;
    for (const field of Object.keys(json)) {
      if (!["sha256", "size", "parts", "legacyKey"].includes(field)) {
        throw new Error(`A blob reference does not take the field '${field}'`);
      }
    }
    return BlobRef.create({
      sha256: json.sha256 as string,
      size: json.size as number,
      parts: json.parts as BlobPart[] | undefined,
      legacyKey: json.legacyKey === undefined
        ? undefined
        : RecordKey.fromJSON(json.legacyKey),
    });
  }

  toJSON(): BlobRefJSON {
    return {
      sha256: this.sha256,
      size: this.size,
      ...(this.parts === undefined ? {} : {
        parts: this.parts.map((p) => ({ sha256: p.sha256, size: p.size })),
      }),
      ...(this.legacyKey === undefined
        ? {}
        : { legacyKey: this.legacyKey.toString() }),
    };
  }

  /**
   * The keys of the chunks holding this content: its `sha256` when stored
   * as one chunk, otherwise each part's, in order.
   */
  chunkHashes(): readonly string[] {
    return this.parts === undefined
      ? [this.sha256]
      : this.parts.map((part) => part.sha256);
  }

  equals(other: BlobRef): boolean {
    return this.sha256 === other.sha256 && this.size === other.size &&
      partsEqual(this.parts, other.parts) &&
      (this.legacyKey === undefined
        ? other.legacyKey === undefined
        : other.legacyKey !== undefined &&
          this.legacyKey.equals(other.legacyKey));
  }
}

function readParts(value: unknown, size: number): readonly BlobPart[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Blob parts must be an array");
  }
  if (value.length < 2) {
    throw new Error(
      "Blob parts list two or more chunks; one chunk needs no parts",
    );
  }
  let total = 0;
  const parts = value.map((part: unknown, index) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      throw new TypeError(`Blob part ${index} must be an object`);
    }
    const fields = part as Record<string, unknown>;
    for (const field of Object.keys(fields)) {
      if (field !== "sha256" && field !== "size") {
        throw new Error(`A blob part does not take the field '${field}'`);
      }
    }
    if (!isSha256Hex(fields.sha256)) {
      throw new Error(
        `Blob part ${index} sha256 must be 64 lowercase hex characters: ${
          String(fields.sha256)
        }`,
      );
    }
    if (!Number.isSafeInteger(fields.size) || (fields.size as number) < 1) {
      throw new Error(
        `Blob part ${index} size must be a positive integer: ${
          String(fields.size)
        }`,
      );
    }
    total += fields.size as number;
    return Object.freeze({
      sha256: fields.sha256,
      size: fields.size as number,
    });
  });
  if (total !== size) {
    throw new Error(
      `Blob part sizes add up to ${total}, not the blob size ${size}`,
    );
  }
  return Object.freeze(parts);
}

function partsEqual(
  a: readonly BlobPart[] | undefined,
  b: readonly BlobPart[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length &&
    a.every((part, i) =>
      part.sha256 === b[i].sha256 && part.size === b[i].size
    );
}
