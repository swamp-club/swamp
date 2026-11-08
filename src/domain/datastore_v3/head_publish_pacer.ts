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
 * above GCS's one mutation a second per object, which it measures on arrival:
 * writes sent exactly a second apart can land closer when one is slow
 */
export const HEAD_PUBLISH_INTERVAL_MS = 1_200;

/**
 * spaces the writes of one lineage head: a head nobody wrote within the
 * interval goes out at once, a later one waits out the rest of it
 */
export class HeadPublishPacer {
  readonly #intervalMs: number;
  #lastAttemptAt: number | undefined;

  constructor(intervalMs: number = HEAD_PUBLISH_INTERVAL_MS) {
    this.#intervalMs = intervalMs;
  }

  waitMs(now: number): number {
    if (this.#lastAttemptAt === undefined) return 0;
    return Math.max(0, this.#lastAttemptAt + this.#intervalMs - now);
  }

  /** a refused or failed write still counts against the bucket's window */
  attempted(at: number): void {
    this.#lastAttemptAt = this.#lastAttemptAt === undefined
      ? at
      : Math.max(this.#lastAttemptAt, at);
  }
}
