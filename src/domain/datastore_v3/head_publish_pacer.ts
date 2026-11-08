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

// GCS counts its one write a second per object on arrival, so leave a margin
export const HEAD_PUBLISH_INTERVAL_MS = 1_200;

/** how long after its last refusal a head stays paced */
export const HEAD_PACING_COOL_DOWN_MS = 30_000;

/**
 * a head is published at once until the bucket refuses one of its writes;
 * pacing then holds until a cool-down passes with no refusal, so a member's
 * back-to-back commits pay nothing on a bucket that never pushes back
 */
export class HeadPublishPacer {
  readonly #intervalMs: number;
  readonly #coolDownMs: number;
  #lastAttemptAt: number | undefined;
  #lastRefusedAt: number | undefined;

  constructor(
    intervalMs: number = HEAD_PUBLISH_INTERVAL_MS,
    coolDownMs: number = HEAD_PACING_COOL_DOWN_MS,
  ) {
    this.#intervalMs = intervalMs;
    this.#coolDownMs = coolDownMs;
  }

  pacing(now: number): boolean {
    return this.#lastRefusedAt !== undefined &&
      now - this.#lastRefusedAt < this.#coolDownMs;
  }

  waitMs(now: number): number {
    if (!this.pacing(now) || this.#lastAttemptAt === undefined) return 0;
    return Math.max(0, this.#lastAttemptAt + this.#intervalMs - now);
  }

  /**
   * the wait to take before a sync with deadlineMs left; 0 when waiting would
   * leave it less than minSyncMs, and the write retry takes the refusal instead
   */
  waitWithin(now: number, deadlineMs: number, minSyncMs: number): number {
    const wait = this.waitMs(now);
    return deadlineMs - wait < minSyncMs ? 0 : wait;
  }

  attempted(at: number): void {
    this.#lastAttemptAt = Math.max(this.#lastAttemptAt ?? at, at);
  }

  rateLimited(at: number): void {
    this.#lastRefusedAt = Math.max(this.#lastRefusedAt ?? at, at);
  }
}
