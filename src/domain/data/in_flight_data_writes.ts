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
 * a write a method started is waited for this long after a run's abort, and
 * after a repeated stop signal; stays under serve's abort graces so serve still
 * sees an aborted run finish
 */
export const DATA_WRITE_STOP_GRACE_MS = 4_750;

/**
 * data writes a method has started and not yet seen settle, so a cancelled run
 * or a repeated stop signal can let them land instead of cutting them off
 */
export class InFlightDataWrites {
  readonly #pending = new Set<Promise<void>>();
  readonly #parent: InFlightDataWrites | undefined;

  constructor(parent?: InFlightDataWrites) {
    this.#parent = parent;
  }

  get size(): number {
    return this.#pending.size;
  }

  track<T>(write: Promise<T>): Promise<T> {
    const release = () => {
      this.#pending.delete(settled);
    };
    const settled: Promise<void> = write.then(release, release);
    this.#pending.add(settled);
    return this.#parent?.track(write) ?? write;
  }

  /**
   * waits while any write is pending, including ones started during the wait,
   * and returns how many were still pending at the deadline
   */
  async settle(waitMs: number): Promise<number> {
    const deadline = performance.now() + waitMs;
    while (this.#pending.size > 0) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      });
      try {
        await Promise.race([Promise.allSettled([...this.#pending]), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
    return this.#pending.size;
  }
}

/** the process's writes, which a repeated stop signal waits for */
export const processDataWrites = new InFlightDataWrites();
