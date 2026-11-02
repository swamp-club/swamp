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
 * every post-drain stage that waits on datastore storage takes its bound from
 * this one deadline, so a slow bucket cannot hold shutdown past the pod grace
 * period: the drain timeout plus about 25 s
 */

/**
 * 22 s so that the up to six floored or self-capped stages, each adding at most
 * SHUTDOWN_STAGE_FLOOR_MS once the budget is spent, keep shutdown near 25 s
 */
export const SHUTDOWN_AFTER_DRAIN_BUDGET_MS = 22_000;

/**
 * The least any stage is given, so that one whose turn comes after the
 * budget is spent still makes one short attempt rather than none.
 */
export const SHUTDOWN_STAGE_FLOOR_MS = 500;

export class ShutdownDeadline {
  private constructor(
    readonly at: number,
    private readonly now: () => number,
  ) {}

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

  remaining(capMs?: number): number {
    return Math.max(SHUTDOWN_STAGE_FLOOR_MS, this.left(capMs));
  }

  /** what is left with no floor, so a stage whose turn comes too late gets 0 */
  left(capMs?: number): number {
    const left = Math.max(0, this.at - this.now());
    return capMs === undefined ? left : Math.min(capMs, left);
  }
}
