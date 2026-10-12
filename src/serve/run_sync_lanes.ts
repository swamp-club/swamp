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

/** The two kinds of run sync the sync gate's shared mode admits. */
export type RunSyncLane = "pull" | "push";

interface Waiter {
  readonly lane: RunSyncLane;
  grant: () => void;
}

/**
 * Keeps run pulls and run pushes apart inside the sync gate's shared mode
 * (swamp-club#3146). Any number of holders of one lane run together, so
 * fan-out pushes keep their parallel uploads and step-start pulls run side
 * by side, but a pull never overlaps a push. A step-start pull that read the
 * remote's older `latest` marker before another run's push committed would
 * otherwise write it over the local marker after that push verified it, and
 * the next upload of the marker would publish the older version again.
 *
 * Queued acquirers are granted in arrival order, a run of consecutive
 * same-lane waiters at once, so a steady stream of one lane cannot starve
 * the other. An acquirer that finds nobody queued and its own lane (or
 * nobody) active joins at once.
 */
export class RunSyncLanes {
  #active: RunSyncLane | undefined;
  #holders = 0;
  readonly #queue: Waiter[] = [];

  /** The lane currently held, if any. */
  get active(): RunSyncLane | undefined {
    return this.#active;
  }

  /** Number of current holders of the active lane. */
  get holders(): number {
    return this.#holders;
  }

  /** Number of queued acquirers. */
  get waiters(): number {
    return this.#queue.length;
  }

  /** Enters `lane`, waiting while the other lane is held or queued ahead. */
  acquire(lane: RunSyncLane, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }
    if (
      this.#queue.length === 0 &&
      (this.#active === undefined || this.#active === lane)
    ) {
      this.#active = lane;
      this.#holders++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index === -1) return;
        this.#queue.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        // A removed head may have been all that kept its followers waiting.
        this.#drain();
      };
      const waiter: Waiter = {
        lane,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  /** Leaves the active lane. */
  release(): void {
    if (this.#holders === 0) {
      throw new Error("RunSyncLanes: release() without a holder");
    }
    this.#holders--;
    if (this.#holders === 0) this.#active = undefined;
    this.#drain();
  }

  #drain(): void {
    while (this.#queue.length > 0) {
      const head = this.#queue[0];
      if (this.#active !== undefined && this.#active !== head.lane) return;
      this.#queue.shift();
      this.#active = head.lane;
      this.#holders++;
      head.grant();
    }
  }
}
