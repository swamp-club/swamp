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
  currentDiagnosticArea,
  currentDiagnosticTally,
  type DiagnosticArea,
  PhaseTally,
  withDiagnosticTally,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import { runOutsideAmbientContext } from "../runtime/ambient_context.ts";

export interface SharedScanOutcome<T> {
  value: T;
  joined: boolean;
}

export type SharedScanWork<W, T> = (
  window: W,
  signal: AbortSignal,
) => Promise<T>;

interface Waiter<T> {
  resolve: (outcome: SharedScanOutcome<T>) => void;
  reject: (reason: unknown) => void;
  report: PhaseTally;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Flight<W, T> {
  window: W;
  readonly work: SharedScanWork<W, T>;
  readonly waiters: Set<Waiter<T>>;
  readonly controller: AbortController;
  readonly area: DiagnosticArea | undefined;
  readonly tally: PhaseTally;
}

interface Slot<W, T> {
  running?: Flight<W, T>;
  pending?: Flight<W, T>;
}

/**
 * callers join only the pending flight, so each result comes from a scan begun
 * after it arrived; the work runs outside every caller's async context so no
 * ambient authority leaks between callers
 */
export class SharedScans<W, T> {
  private readonly slots = new Map<string, Slot<W, T>>();

  constructor(private readonly widen: (a: W, b: W) => W) {}

  /**
   * calls for one key must pass equivalent work: the flight runs the work of
   * the caller that created it
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
    if (flight === undefined) {
      const area = currentDiagnosticArea();
      flight = {
        window,
        work,
        waiters: new Set(),
        controller: new AbortController(),
        area,
        tally: new PhaseTally(area !== undefined),
      };
      slot.pending = flight;
      if (slot.running === undefined) this.scheduleStart(key, slot);
    } else {
      flight.window = this.widen(flight.window, window);
    }
    const pending = flight;
    const owner = slot;
    return new Promise((resolve, reject) => {
      const waiter: Waiter<T> = {
        resolve,
        reject,
        report: currentDiagnosticTally(),
        signal,
      };
      pending.waiters.add(waiter);
      if (signal !== undefined) {
        waiter.onAbort = () => {
          pending.waiters.delete(waiter);
          if (pending.waiters.size === 0) {
            if (owner.pending === pending) {
              // Never started: drop it, so it never reads.
              owner.pending = undefined;
              this.releaseIfIdle(key, owner);
            } else {
              // The last to leave takes what the work reached, before its
              // phase ends with this rejection.
              waiter.report.merge(pending.tally);
              pending.controller.abort(signal.reason);
            }
          }
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  has(key: string): boolean {
    return this.slots.has(key);
  }

  /**
   * starts on a later microtask, never in a caller's or settling flight's
   * frame, so callers made together join first and a failure surfaces only on
   * its own flight
   */
  private scheduleStart(key: string, slot: Slot<W, T>): void {
    queueMicrotask(() => {
      const flight = slot.pending;
      if (flight === undefined || slot.running !== undefined) return;
      slot.pending = undefined;
      slot.running = flight;
      // Not awaited, and safe to leave: fly never rejects, and every caller
      // on the flight awaits its own promise, which fly settles.
      void this.fly(key, slot, flight);
    });
  }

  /**
   * never rejects: every outcome goes to the callers, and the running slot is
   * cleared and the next flight scheduled however the work ends
   */
  private async fly(
    key: string,
    slot: Slot<W, T>,
    flight: Flight<W, T>,
  ): Promise<void> {
    try {
      // Inside an async function, so work that throws before returning a
      // promise rejects this flight like any other failure.
      const value = await runOutsideAmbientContext(async () => {
        const work = () => flight.work(flight.window, flight.controller.signal);
        return await (flight.area === undefined
          ? work()
          : withDiagnosticTally(flight.area, flight.tally, work));
      });
      const [reporter, ...others] = this.leave(flight);
      reporter?.resolve({ value, joined: false });
      for (const waiter of others) waiter.resolve({ value, joined: true });
    } catch (error) {
      for (const waiter of this.leave(flight)) waiter.reject(error);
    } finally {
      slot.running = undefined;
      if (slot.pending !== undefined) this.scheduleStart(key, slot);
      else this.releaseIfIdle(key, slot);
    }
  }

  private leave(flight: Flight<W, T>): Waiter<T>[] {
    const waiters = [...flight.waiters];
    flight.waiters.clear();
    waiters[0]?.report.merge(flight.tally);
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
