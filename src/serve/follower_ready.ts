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
 * A serve node that starts as a follower in team mode reports `/ready` only
 * once its copy first holds the head its leader names (swamp-club#4254). A
 * node restarted after a takeover restores its copy from the bucket, which
 * can trail the leader; in rotation before its feed catches it up, it would
 * answer members from behind their copies. The wait is bounded, so a slow
 * restore cannot hold the node out of rotation for long, and it ends as
 * soon as the node takes the lead or begins to shut down.
 *
 * @module
 */

/** The longest a follower's readiness waits for its first catch-up. */
export const FOLLOWER_READY_WAIT_MS = 30_000;

/** How long between tries while the leader feed is not yet live. */
export const FOLLOWER_READY_RETRY_MS = 250;

/** What {@link awaitFirstFollowerCatchUp} needs. */
export interface FirstFollowerCatchUpDeps {
  /** Whether the copy holds the leader's head, after a bounded wait. */
  caughtUp(): Promise<boolean>;
  /** Whether to stop waiting: the node leads, or it is shutting down. */
  ended(): boolean;
  readonly boundMs?: number;
  readonly retryMs?: number;
  readonly now?: () => number;
  readonly pause?: (ms: number) => Promise<void>;
}

/** How the wait for a follower's first catch-up ended. */
export type FirstFollowerCatchUp = "caught-up" | "ended" | "timed-out";

/** See the module documentation. */
export async function awaitFirstFollowerCatchUp(
  deps: FirstFollowerCatchUpDeps,
): Promise<FirstFollowerCatchUp> {
  const now = deps.now ?? Date.now;
  const pause = deps.pause ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const bound = deps.boundMs ?? FOLLOWER_READY_WAIT_MS;
  const retry = deps.retryMs ?? FOLLOWER_READY_RETRY_MS;
  const start = now();
  for (;;) {
    if (deps.ended()) return "ended";
    if (await deps.caughtUp()) return "caught-up";
    if (deps.ended()) return "ended";
    if (now() - start >= bound) return "timed-out";
    await pause(retry);
  }
}
