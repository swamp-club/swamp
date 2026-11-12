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

import fc from "fast-check";
import type { SchedulerClock } from "./workflow_scheduler.ts";

export const HOUR_MS = 60 * 60 * 1000;

// each zone's 2026 transitions, fall-back first, so a draw lands in its
// repeated or skipped hour often rather than once in thousands of runs
export const ZONES: Record<string, readonly string[]> = {
  "UTC": [],
  "America/Chicago": ["2026-11-01T07:00:00Z", "2026-03-08T08:00:00Z"],
  "Europe/London": ["2026-10-25T01:00:00Z", "2026-03-29T01:00:00Z"],
  "Australia/Lord_Howe": ["2026-04-04T15:00:00Z", "2026-10-03T15:30:00Z"],
  "America/Santiago": ["2026-04-05T03:00:00Z", "2026-09-06T04:00:00Z"],
};

const arbYearMs = fc.integer({
  min: Date.UTC(2026, 0, 1),
  max: Date.UTC(2027, 0, 1),
});

export function arbNear(at: string): fc.Arbitrary<number> {
  return fc.integer({ min: -2 * HOUR_MS, max: 2 * HOUR_MS }).map((offset) =>
    Date.parse(at) + offset
  );
}

export const arbZoneAndWatermark = fc.constantFrom(...Object.keys(ZONES)).chain(
  (
    timezone,
  ) =>
    fc.record({
      timezone: fc.constant(timezone),
      watermarkMs: ZONES[timezone].length === 0
        ? arbYearMs
        : fc.oneof(arbYearMs, ...ZONES[timezone].map(arbNear)),
    }),
);

interface PendingTimer {
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
}

/** runs due timers in order on `advanceTo`, so a fire can re-arm itself */
export class FakeSchedulerClock implements SchedulerClock {
  private current: number;
  private seq = 0;
  private readonly pending = new Set<PendingTimer>();
  /** every delay asked for, to assert on how far ahead a timer is armed */
  readonly delays: number[] = [];

  constructor(start: Date | number) {
    this.current = typeof start === "number" ? start : start.getTime();
  }

  now(): number {
    return this.current;
  }

  setTimer(fn: () => void, ms: number): () => void {
    this.delays.push(ms);
    const timer = { at: this.current + Math.max(ms, 0), seq: this.seq++, fn };
    this.pending.add(timer);
    return () => this.pending.delete(timer);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** a scheduler that re-arms at a zero delay would never pass `maxRuns` */
  advanceTo(target: Date | number, maxRuns = 100_000): void {
    const end = typeof target === "number" ? target : target.getTime();
    for (let runs = 0;; runs++) {
      let due: PendingTimer | undefined;
      for (const timer of this.pending) {
        if (
          timer.at <= end &&
          (!due || timer.at < due.at ||
            (timer.at === due.at && timer.seq < due.seq))
        ) {
          due = timer;
        }
      }
      if (!due) break;
      if (runs >= maxRuns) {
        throw new Error(
          `more than ${maxRuns} timers ran before ${
            new Date(end).toISOString()
          }`,
        );
      }
      this.pending.delete(due);
      this.current = Math.max(this.current, due.at);
      due.fn();
    }
    this.current = Math.max(this.current, end);
  }
}
