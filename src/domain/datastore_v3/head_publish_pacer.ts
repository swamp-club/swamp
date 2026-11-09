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
 * how long after its last contended sync a head stays paced: short, so members
 * that collide once do not pace each other's sequential commits for long
 */
export const HEAD_CONTENTION_COOL_DOWN_MS = 5_000;

/**
 * a head goes out at once until the bucket refuses a write or requests queue
 * behind a sync, then is paced until a cool-down passes without either
 */
export class HeadPublishPacer {
  readonly #intervalMs: number;
  readonly #coolDownMs: number;
  readonly #contentionCoolDownMs: number;
  #lastAttemptAt: number | undefined;
  #lastRefusedAt: number | undefined;
  #lastContendedAt: number | undefined;

  constructor(
    intervalMs: number = HEAD_PUBLISH_INTERVAL_MS,
    coolDownMs: number = HEAD_PACING_COOL_DOWN_MS,
    contentionCoolDownMs: number = HEAD_CONTENTION_COOL_DOWN_MS,
  ) {
    this.#intervalMs = intervalMs;
    this.#coolDownMs = coolDownMs;
    this.#contentionCoolDownMs = contentionCoolDownMs;
  }

  pacing(now: number): boolean {
    return (this.#lastRefusedAt !== undefined &&
      now - this.#lastRefusedAt < this.#coolDownMs) ||
      (this.#lastContendedAt !== undefined &&
        now - this.#lastContendedAt < this.#contentionCoolDownMs);
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

  /** more than one request was queued behind a running sync */
  contended(at: number): void {
    this.#lastContendedAt = Math.max(this.#lastContendedAt ?? at, at);
  }
}
