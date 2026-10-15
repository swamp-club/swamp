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
 * Group commit for serve's write requests (swamp-club#3489, Phase 4D3):
 * concurrent requests share the syncs that confirm their commits are
 * replicated, instead of one sync each.
 *
 * Pure: the sync is passed in, and nothing here keeps time. See "Phase 4D3"
 * in `design/enablers/datastore-litestream.md`.
 *
 * @module
 */

import { V3ReplicationError } from "./litestream_replication.ts";

/**
 * Syncs the replica and publishes its head: resolves with the high-water
 * mark the published head covers, or undefined when no head was published.
 * Rejects when the sync was not confirmed.
 */
export type GroupSync = () => Promise<number | undefined>;

interface Waiter {
  readonly mark: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Confirms marks with as few syncs as concurrent callers allow. A caller is
 * confirmed by a successful sync whose published head covers its mark. One
 * sync runs at a time; when it settles, the next starts at once for every
 * caller it did not confirm, covering everything committed meanwhile.
 */
export class ReplicationGroupCommit {
  readonly #sync: GroupSync;
  #waiting: Waiter[] = [];
  #syncing = false;

  constructor(sync: GroupSync) {
    this.#sync = sync;
  }

  /**
   * Resolves once a published head covers `mark`, the high-water mark read
   * after the caller's commits landed. Rejects with the error of the sync
   * that should have covered it.
   */
  confirm(mark: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#waiting.push({ mark, resolve, reject });
      this.#next();
    });
  }

  #next(): void {
    if (this.#syncing || this.#waiting.length === 0) return;
    this.#syncing = true;
    // Every caller waiting now committed before this sync started, so its
    // head covers them; callers arriving meanwhile wait for the next one
    // unless the head happens to cover them too.
    const covered = this.#waiting;
    this.#waiting = [];
    let sync: Promise<number | undefined>;
    try {
      sync = this.#sync();
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
        for (const waiter of covered) waiter.reject(error);
      },
    ).finally(() => {
      this.#syncing = false;
      this.#next();
    });
  }
}
