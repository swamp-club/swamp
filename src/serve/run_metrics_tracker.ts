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

export type RunOutcome = "completed" | "failed" | "cancelled";

interface RunRecord {
  readonly outcome: RunOutcome;
  readonly durationMs: number;
  readonly timestamp: number;
}

export interface RunMetricsSnapshot {
  readonly windowMs: number;
  readonly completions: number;
  readonly failures: number;
  readonly cancellations: number;
  readonly throughputPerMinute: number;
  readonly latency: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  };
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const MAX_RECORDS = 10_000;

export class RunMetricsTracker {
  readonly #windowMs: number;
  readonly #records: RunRecord[] = [];

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.#windowMs = windowMs;
  }

  record(outcome: RunOutcome, durationMs: number): void {
    const now = Date.now();
    this.#records.push({ outcome, durationMs, timestamp: now });
    if (this.#records.length > MAX_RECORDS) {
      this.#prune(now);
    }
  }

  snapshot(): RunMetricsSnapshot {
    const now = Date.now();
    this.#prune(now);

    const cutoff = now - this.#windowMs;
    const windowRecords = this.#records.filter((r) => r.timestamp >= cutoff);

    let completions = 0;
    let failures = 0;
    let cancellations = 0;
    const durations: number[] = [];

    for (const r of windowRecords) {
      switch (r.outcome) {
        case "completed":
          completions++;
          break;
        case "failed":
          failures++;
          break;
        case "cancelled":
          cancellations++;
          break;
      }
      durations.push(r.durationMs);
    }

    const total = completions + failures + cancellations;
    const windowMinutes = this.#windowMs / 60_000;
    const throughputPerMinute = windowMinutes > 0
      ? Math.round((total / windowMinutes) * 100) / 100
      : 0;

    durations.sort((a, b) => a - b);

    return {
      windowMs: this.#windowMs,
      completions,
      failures,
      cancellations,
      throughputPerMinute,
      latency: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
      },
    };
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    let i = 0;
    while (i < this.#records.length && this.#records[i].timestamp < cutoff) {
      i++;
    }
    if (i > 0) {
      this.#records.splice(0, i);
    }
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
