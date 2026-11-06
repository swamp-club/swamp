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

// Counted in compact bytes; leaves room for pretty-printing deeply nested
// content to expand about 30x before the result reaches V8's string limit.
export const RESOURCE_ATTRIBUTE_CAP_BYTES = 16 * 1024 * 1024;

/**
 * once a resource is refused every later one is too, so the omitted resources
 * are always the run's last ones; a size that is not a byte count is refused
 */
export class ResourceAttributeBudget {
  readonly capBytes: number;
  #admittedBytes = 0;
  #exhausted = false;

  constructor(capBytes: number = RESOURCE_ATTRIBUTE_CAP_BYTES) {
    if (!Number.isSafeInteger(capBytes) || capBytes < 0) {
      throw new RangeError(
        `Resource attribute cap must be a non-negative integer, got ${capBytes}`,
      );
    }
    this.capBytes = capBytes;
  }

  get admittedBytes(): number {
    return this.#admittedBytes;
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  admit(bytes: number): boolean {
    if (this.#exhausted) return false;
    if (
      !Number.isFinite(bytes) || bytes < 0 ||
      this.#admittedBytes + bytes > this.capBytes
    ) {
      this.#exhausted = true;
      return false;
    }
    this.#admittedBytes += bytes;
    return true;
  }
}

/**
 * the UTF-8 length of JSON.stringify(value), or undefined once it would pass
 * limit; never builds the whole string, so a value too large for one string is
 * refused instead of throwing
 */
export function jsonByteLengthWithin(
  value: unknown,
  limit: number,
): number | undefined {
  const encoder = new TextEncoder();
  let total = 0;
  const add = (bytes: number) => (total += bytes) <= limit;
  const skipped = (v: unknown) =>
    v === undefined || typeof v === "function" || typeof v === "symbol";
  const walk = (v: unknown): boolean => {
    if (typeof v === "string") {
      // every UTF-16 unit encodes to at least one byte
      if (v.length > limit - total) return false;
      return add(encoder.encode(JSON.stringify(v)).length);
    }
    if (Array.isArray(v)) {
      if (!add(2 + Math.max(v.length - 1, 0))) return false;
      for (const item of v) {
        if (!(skipped(item) ? add(4) : walk(item))) return false;
      }
      return true;
    }
    if (
      typeof v === "object" && v !== null &&
      typeof (v as { toJSON?: unknown }).toJSON !== "function"
    ) {
      const entries = Object.entries(v).filter(([, x]) => !skipped(x));
      if (!add(2 + Math.max(entries.length - 1, 0))) return false;
      for (const [key, x] of entries) {
        if (!walk(key) || !add(1) || !walk(x)) return false;
      }
      return true;
    }
    const text = JSON.stringify(v);
    return add(text === undefined ? 0 : encoder.encode(text).length);
  };
  return walk(value) ? total : undefined;
}
