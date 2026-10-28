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

import { AsyncLocalStorage } from "node:async_hooks";

/** A shared scan's result, and whether this caller joined another's scan. */
export interface SharedScanOutcome<T> {
  value: T;
  /**
   * True when another caller started the scan: its work, and the
   * diagnostic counters it records, belong to that caller's context.
   */
  joined: boolean;
}

/** Reads `window` until `signal` aborts. */
export type SharedScanWork<W, T> = (
  window: W,
  signal: AbortSignal,
) => Promise<T>;

interface Waiter<T> {
  resolve: (outcome: SharedScanOutcome<T>) => void;
  reject: (reason: unknown) => void;
  joined: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Flight<W, T> {
  window: W;
  readonly work: SharedScanWork<W, T>;
  readonly waiters: Set<Waiter<T>>;
  readonly controller: AbortController;
  /** Runs a function in the async context of the caller that created it. */
  readonly inCreatorContext: <R>(fn: () => R) => R;
}

interface Slot<W, T> {
  running?: Flight<W, T>;
  pending?: Flight<W, T>;
}

/**
 * Concurrent callers of the same scan share one in-flight read
 * (swamp-club#4074). Per key there is at most one running flight and one
 * pending flight. A caller joins the pending flight, or creates it, but
 * never the running one: a flight takes callers only until it starts, so
 * each result comes from a scan that began after its caller arrived, and
 * no write, in this process or another, needs to invalidate anything. The
 * pending flight starts once nothing runs for its key.
 *
 * A caller joining widens the pending flight's window with `widen`, so
 * callers asking for different windows (a relative `since` is a new cutoff
 * on every request) still share; each then keeps only its own window of
 * the result. The result is shared as is: callers must not mutate it.
 *
 * A caller whose signal aborts rejects at once with its reason. The flight
 * itself is aborted only once every caller on it has left, and a pending
 * flight every caller left never starts. A failed flight rejects every
 * caller on it, and the next call starts a fresh one.
 */
export class SharedScans<W, T> {
  private readonly slots = new Map<string, Slot<W, T>>();

  constructor(private readonly widen: (a: W, b: W) => W) {}

  /**
   * `work` over `window`, shared with the other callers of `key` that
   * arrive before it starts. Calls for one key must pass equivalent work:
   * the flight runs the work of the caller that created it.
   */
  run(
    key: string,
    window: W,
    work: SharedScanWork<W, T>,
    signal?: AbortSignal,
  ): Promise<SharedScanOutcome<T>> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = {};
      this.slots.set(key, slot);
    }
    let flight = slot.pending;
    const joined = flight !== undefined;
    if (flight === undefined) {
      flight = {
        window,
        work,
        waiters: new Set(),
        controller: new AbortController(),
        inCreatorContext: AsyncLocalStorage.snapshot(),
      };
      slot.pending = flight;
      if (slot.running === undefined) this.scheduleStart(key, slot);
    } else {
      flight.window = this.widen(flight.window, window);
    }
    const pending = flight;
    const owner = slot;
    return new Promise((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject, joined, signal };
      pending.waiters.add(waiter);
      if (signal !== undefined) {
        waiter.onAbort = () => {
          pending.waiters.delete(waiter);
          reject(signal.reason);
          if (pending.waiters.size > 0) return;
          if (owner.pending === pending) {
            // Never started: drop it, so it never reads.
            owner.pending = undefined;
            this.releaseIfIdle(key, owner);
          } else {
            pending.controller.abort(signal.reason);
          }
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  /** Whether any flight, running or pending, is held for `key`. */
  has(key: string): boolean {
    return this.slots.has(key);
  }

  /**
   * Starts `slot`'s pending flight on a later microtask, never inside the
   * caller's or a settling flight's own frame, so callers made together
   * join it first and a failure surfaces only on the flight it belongs to.
   */
  private scheduleStart(key: string, slot: Slot<W, T>): void {
    queueMicrotask(() => {
      const flight = slot.pending;
      if (flight === undefined || slot.running !== undefined) return;
      slot.pending = undefined;
      slot.running = flight;
      void this.fly(key, slot, flight);
    });
  }

  /**
   * Runs `flight` and settles every caller still on it. Never rejects:
   * every outcome goes to the callers. The running slot is cleared, and the
   * next flight scheduled, however the work ends.
   */
  private async fly(
    key: string,
    slot: Slot<W, T>,
    flight: Flight<W, T>,
  ): Promise<void> {
    try {
      // Inside an async function, so work that throws before returning a
      // promise rejects this flight like any other failure.
      const value = await flight.inCreatorContext(async () =>
        await flight.work(flight.window, flight.controller.signal)
      );
      for (const waiter of this.leave(flight)) {
        waiter.resolve({ value, joined: waiter.joined });
      }
    } catch (error) {
      for (const waiter of this.leave(flight)) waiter.reject(error);
    } finally {
      slot.running = undefined;
      if (slot.pending !== undefined) this.scheduleStart(key, slot);
      else this.releaseIfIdle(key, slot);
    }
  }

  /** `flight`'s callers, each detached from its signal, as it settles. */
  private leave(flight: Flight<W, T>): Waiter<T>[] {
    const waiters = [...flight.waiters];
    flight.waiters.clear();
    for (const waiter of waiters) {
      if (waiter.onAbort !== undefined) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      }
    }
    return waiters;
  }

  private releaseIfIdle(key: string, slot: Slot<W, T>): void {
    if (
      slot.running === undefined && slot.pending === undefined &&
      this.slots.get(key) === slot
    ) {
      this.slots.delete(key);
    }
  }
}
