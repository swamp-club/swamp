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
 * The one deadline a `swamp serve` shutdown has (swamp-club#3961). Every
 * stage after the drain that waits on the datastore's storage (the interrupt
 * commit or push, the active-run records and stopped heartbeat, the v3
 * sidecar upkeep, the closing sync and the writer lease release) takes its
 * bound from it, so a slow or stalled bucket cannot hold shutdown past the
 * pod grace period serve's documentation asks for: the drain timeout plus
 * about 25 s.
 */

/**
 * How long shutdown may run past the drain timeout, the abort grace
 * included. A floor that bites once it is spent can add up to
 * {@link SHUTDOWN_STAGE_FLOOR_MS} per stage, so it stays a little below 25 s.
 */
export const SHUTDOWN_AFTER_DRAIN_BUDGET_MS = 23_000;

/**
 * The least any stage is given, so that one whose turn comes after the
 * budget is spent still makes one short attempt rather than none.
 */
export const SHUTDOWN_STAGE_FLOOR_MS = 500;

/** A fixed point in time each shutdown stage measures what is left against. */
export class ShutdownDeadline {
  private constructor(
    /** Epoch milliseconds. */
    readonly at: number,
    private readonly now: () => number,
  ) {}

  /**
   * The deadline of a shutdown that started at `startedAt` (epoch
   * milliseconds) with a drain timeout of `drainTimeoutMs`.
   */
  static forShutdown(
    startedAt: number,
    drainTimeoutMs: number,
    options: { readonly now?: () => number; readonly budgetMs?: number } = {},
  ): ShutdownDeadline {
    return new ShutdownDeadline(
      startedAt + Math.max(0, drainTimeoutMs) +
        (options.budgetMs ?? SHUTDOWN_AFTER_DRAIN_BUDGET_MS),
      options.now ?? Date.now,
    );
  }

  /**
   * What a stage may wait: the time left, capped at `capMs` when given,
   * and never below {@link SHUTDOWN_STAGE_FLOOR_MS}.
   */
  remaining(capMs?: number): number {
    const left = this.at - this.now();
    const bounded = capMs === undefined ? left : Math.min(capMs, left);
    return Math.max(SHUTDOWN_STAGE_FLOOR_MS, bounded);
  }
}
