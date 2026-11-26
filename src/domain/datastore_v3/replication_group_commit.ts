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

import {
  HeadPublishRateLimitedError,
  V3ReplicationError,
} from "./litestream_replication.ts";

/** `covering`: how many callers the sync confirms, queued behind the last one */
export type GroupSync = (covering: number) => Promise<number | undefined>;

export interface GroupCommitClock {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

const SYSTEM_CLOCK: GroupCommitClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Waiter {
  readonly mark: number;
  /** kept once already through a round failed by a rate-limited head */
  kept: boolean;
  settled: boolean;
  timer: unknown;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * one sync runs at a time; when it settles the next starts at once for every
 * caller it did not confirm, covering everything committed meanwhile
 */
export class ReplicationGroupCommit {
  readonly #sync: GroupSync;
  readonly #clock: GroupCommitClock;
  #waiting: Waiter[] = [];
  #syncing = false;

  constructor(sync: GroupSync, clock: GroupCommitClock = SYSTEM_CLOCK) {
    this.#sync = sync;
    this.#clock = clock;
  }

  /**
   * a caller with a deadline is rejected at it, whether or not a round is
   * running for it
   */
  confirm(mark: number, deadlineAt?: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        mark,
        kept: false,
        settled: false,
        timer: undefined,
        resolve: () => {
          if (this.#settle(waiter)) resolve();
        },
        reject: (error) => {
          if (this.#settle(waiter)) reject(error);
        },
      };
      if (deadlineAt !== undefined && deadlineAt <= this.#clock.now()) {
        // a sync nobody waits for would only add to the head's write rate
        waiter.reject(
          new V3ReplicationError(
            `no published head covered commit ${mark} within its deadline`,
          ),
        );
        return;
      }
      if (deadlineAt !== undefined) {
        waiter.timer = this.#clock.setTimer(() => {
          this.#waiting = this.#waiting.filter((other) => other !== waiter);
          waiter.reject(
            new V3ReplicationError(
              `no published head covered commit ${mark} within its deadline`,
            ),
          );
        }, deadlineAt - this.#clock.now());
      }
      this.#waiting.push(waiter);
      this.#next();
    });
  }

  /** false when the waiter was already settled */
  #settle(waiter: Waiter): boolean {
    if (waiter.settled) return false;
    waiter.settled = true;
    if (waiter.timer !== undefined) this.#clock.clearTimer(waiter.timer);
    return true;
  }

  /** a confirm asked while this is true waits for the next sync */
  get syncing(): boolean {
    return this.#syncing;
  }

  #next(): void {
    if (this.#syncing) return;
    this.#waiting = this.#waiting.filter((waiter) => !waiter.settled);
    if (this.#waiting.length === 0) return;
    this.#syncing = true;
    // Every caller waiting now committed before this sync started, so its
    // head covers them; callers arriving meanwhile wait for the next one
    // unless the head happens to cover them too.
    const covered = this.#waiting;
    this.#waiting = [];
    let sync: Promise<number | undefined>;
    try {
      sync = this.#sync(covered.length);
    } catch (error) {
      sync = Promise.reject(error);
    }
    sync.then(
      (published) => {
        for (const waiter of covered) {
          if (published !== undefined && waiter.mark <= published) {
            waiter.resolve();
          } else {
            // A sync that started after this caller's commits published no
            // head covering them: retrying would not change that.
            waiter.reject(
              new V3ReplicationError(
                published === undefined
                  ? "the sync published no head for the commits"
                  : `the published head covers commit ${published}, not ` +
                    `commit ${waiter.mark}`,
              ),
            );
          }
        }
        if (published !== undefined) {
          this.#waiting = this.#waiting.filter((waiter) => {
            if (waiter.mark > published) return true;
            waiter.resolve();
            return false;
          });
        }
      },
      (error) => {
        // a refused head leaves the commits for the next round's, once
        const retry = error instanceof HeadPublishRateLimitedError;
        for (const waiter of covered) {
          if (waiter.settled) continue;
          if (retry && !waiter.kept) {
            waiter.kept = true;
            this.#waiting.push(waiter);
          } else {
            waiter.reject(error);
          }
        }
      },
    ).finally(() => {
      this.#syncing = false;
      this.#next();
    }).catch(() => {
      // Unreachable: both handlers only settle waiters. Each caller awaits
      // its own `confirm`, which is where a sync's outcome surfaces.
    });
  }
}
