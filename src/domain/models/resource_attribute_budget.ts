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
