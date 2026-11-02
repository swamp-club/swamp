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
 * the timer is unref'd so it never keeps the process alive, and armed outside
 * any active span so it never joins a request's trace
 */

import { runDetached } from "../infrastructure/tracing/mod.ts";

export const DEFAULT_EVENT_LOOP_LAG_INTERVAL_MS = 250;
export const DEFAULT_EVENT_LOOP_LAG_WINDOW_MS = 10_000;

export interface EventLoopLagMonitorOptions {
  intervalMs?: number;
  windowMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, delayMs: number) => number;
  clearTimeout?: (id: number) => void;
  unrefTimer?: (id: number) => void;
}

interface LagSample {
  readonly at: number;
  readonly lagMs: number;
}

export class EventLoopLagMonitor {
  readonly #intervalMs: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #setTimeout: (fn: () => void, delayMs: number) => number;
  readonly #clearTimeout: (id: number) => void;
  readonly #unrefTimer: (id: number) => void;
  #timer: number | null = null;
  #samples: LagSample[] = [];

  constructor(options: EventLoopLagMonitorOptions = {}) {
    this.#intervalMs = options.intervalMs ??
      DEFAULT_EVENT_LOOP_LAG_INTERVAL_MS;
    this.#windowMs = options.windowMs ?? DEFAULT_EVENT_LOOP_LAG_WINDOW_MS;
    this.#now = options.now ?? (() => performance.now());
    this.#setTimeout = options.setTimeout ??
      ((fn, delayMs) =>
        globalThis.setTimeout(fn, delayMs) as unknown as number);
    this.#clearTimeout = options.clearTimeout ??
      ((id) => globalThis.clearTimeout(id));
    this.#unrefTimer = options.unrefTimer ?? ((id) => Deno.unrefTimer(id));
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#arm();
  }

  stop(): void {
    if (this.#timer !== null) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#samples = [];
  }

  maxLagMs(): number | undefined {
    if (this.#timer === null) return undefined;
    this.#prune(this.#now());
    if (this.#samples.length === 0) return undefined;
    let max = 0;
    for (const sample of this.#samples) {
      if (sample.lagMs > max) max = sample.lagMs;
    }
    return max;
  }

  /**
   * each firing re-arms from its own time, so one late firing never shifts the
   * lag measured by the next
   */
  #arm(): void {
    const expectedAt = this.#now() + this.#intervalMs;
    const id = runDetached(() =>
      this.#setTimeout(() => {
        if (this.#timer !== id) return;
        const now = this.#now();
        this.#record(now, Math.max(0, now - expectedAt));
        this.#arm();
      }, this.#intervalMs)
    );
    this.#timer = id;
    this.#unrefTimer(id);
  }

  #record(now: number, lagMs: number): void {
    this.#samples.push({ at: now, lagMs });
    this.#prune(now);
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    let drop = 0;
    while (
      drop < this.#samples.length && this.#samples[drop].at < cutoff
    ) {
      drop++;
    }
    if (drop > 0) this.#samples.splice(0, drop);
  }
}
