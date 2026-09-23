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

type LockMode = "shared" | "exclusive";

interface Waiter {
  readonly mode: LockMode;
  grant: () => void;
}

/**
 * FIFO read/write lock for async operations.
 *
 * Any number of shared holders, or exactly one exclusive holder. Queued
 * acquirers are granted strictly in arrival order, so a queued exclusive
 * acquirer blocks every shared acquirer that arrives after it — a steady
 * stream of shared holders cannot starve it. {@link tryAcquire} takes the
 * exclusive mode only when the lock is idle and nobody is queued, and never
 * joins the queue.
 *
 * The exclusive mode keeps `Semaphore`'s `acquire(signal)` /
 * `release()` shape, so code written against a one-permit semaphore keeps
 * working unchanged.
 */
export class ReadWriteLock {
  #sharedHolders = 0;
  #exclusiveHeld = false;
  readonly #queue: Waiter[] = [];

  /** Number of current shared holders. */
  get sharedHolders(): number {
    return this.#sharedHolders;
  }

  /** Whether the exclusive mode is currently held. */
  get exclusiveHeld(): boolean {
    return this.#exclusiveHeld;
  }

  /** Number of queued acquirers, of either mode. */
  get waiters(): number {
    return this.#queue.length;
  }

  /** Acquires the exclusive mode, waiting in FIFO order. */
  acquire(signal?: AbortSignal): Promise<void> {
    return this.#enqueue("exclusive", signal);
  }

  /** Acquires the shared mode, waiting in FIFO order. */
  acquireShared(signal?: AbortSignal): Promise<void> {
    return this.#enqueue("shared", signal);
  }

  /**
   * Takes the exclusive mode if the lock is idle and nobody is queued.
   * Returns false otherwise, without queueing — so it never delays another
   * acquirer.
   */
  tryAcquire(): boolean {
    if (this.#queue.length > 0 || !this.#canGrant("exclusive")) return false;
    this.#exclusiveHeld = true;
    return true;
  }

  /** Releases the exclusive mode. */
  release(): void {
    if (!this.#exclusiveHeld) {
      throw new Error("ReadWriteLock: release() without an exclusive holder");
    }
    this.#exclusiveHeld = false;
    this.#drain();
  }

  /** Releases one shared holder. */
  releaseShared(): void {
    if (this.#sharedHolders === 0) {
      throw new Error("ReadWriteLock: releaseShared() without a shared holder");
    }
    this.#sharedHolders--;
    this.#drain();
  }

  #canGrant(mode: LockMode): boolean {
    if (this.#exclusiveHeld) return false;
    return mode === "shared" || this.#sharedHolders === 0;
  }

  #take(mode: LockMode): void {
    if (mode === "exclusive") this.#exclusiveHeld = true;
    else this.#sharedHolders++;
  }

  #enqueue(mode: LockMode, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }

    // Only jump straight in when nobody is queued: granting past a queued
    // exclusive acquirer would let shared holders starve it.
    if (this.#queue.length === 0 && this.#canGrant(mode)) {
      this.#take(mode);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.#queue.indexOf(waiter);
        if (idx === -1) return;
        this.#queue.splice(idx, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        // A removed head may have been the only thing blocking the
        // compatible waiters behind it.
        this.#drain();
      };
      const waiter: Waiter = {
        mode,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      this.#queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Grants queued acquirers from the head while they are compatible. */
  #drain(): void {
    while (this.#queue.length > 0 && this.#canGrant(this.#queue[0].mode)) {
      const next = this.#queue.shift()!;
      this.#take(next.mode);
      next.grant();
    }
  }
}
