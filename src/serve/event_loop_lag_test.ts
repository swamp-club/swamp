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

import { assertEquals } from "@std/assert";
import { EventLoopLagMonitor } from "./event_loop_lag.ts";

/** A hand-driven clock and timer queue. */
function fakeTimers() {
  let clock = 1_000;
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; delayMs: number }>();
  const armed: number[] = [];
  const cleared: number[] = [];
  const unrefed: number[] = [];
  return {
    armed,
    cleared,
    unrefed,
    pending,
    advance(ms: number) {
      clock += ms;
    },
    /** Fires the single pending timer `lateByMs` after it was due. */
    fire(lateByMs: number) {
      assertEquals(pending.size, 1);
      const [[id, timer]] = [...pending];
      pending.delete(id);
      clock += timer.delayMs + lateByMs;
      timer.fn();
    },
    options: {
      now: () => clock,
      setTimeout: (fn: () => void, delayMs: number) => {
        const id = nextId++;
        pending.set(id, { fn, delayMs });
        armed.push(id);
        return id;
      },
      clearTimeout: (id: number) => {
        pending.delete(id);
        cleared.push(id);
      },
      unrefTimer: (id: number) => {
        unrefed.push(id);
      },
    },
  };
}

Deno.test("EventLoopLagMonitor: reports undefined before start and before any sample", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor(timers.options);
  assertEquals(monitor.maxLagMs(), undefined);
  monitor.start();
  assertEquals(monitor.maxLagMs(), undefined);
  monitor.stop();
});

Deno.test("EventLoopLagMonitor: computes lag as timer drift from the injected clock", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor({
    ...timers.options,
    intervalMs: 250,
  });
  monitor.start();
  assertEquals(timers.pending.get(1)?.delayMs, 250);
  timers.fire(40);
  assertEquals(monitor.maxLagMs(), 40);
  monitor.stop();
});

Deno.test("EventLoopLagMonitor: an on-time firing records zero lag", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor(timers.options);
  monitor.start();
  timers.fire(0);
  assertEquals(monitor.maxLagMs(), 0);
  monitor.stop();
});

Deno.test("EventLoopLagMonitor: re-arms after each firing and unrefs every timer", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor(timers.options);
  monitor.start();
  timers.fire(5);
  timers.fire(5);
  assertEquals(timers.armed, [1, 2, 3]);
  assertEquals(timers.unrefed, [1, 2, 3]);
  assertEquals([...timers.pending.keys()], [3]);
  monitor.stop();
});

Deno.test("EventLoopLagMonitor: one late firing does not inflate the next sample", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor({
    ...timers.options,
    windowMs: 1_000,
  });
  monitor.start();
  timers.fire(500);
  timers.fire(3);
  timers.advance(800);
  // The 500 ms sample has left the window; the next one measured only 3 ms.
  assertEquals(monitor.maxLagMs(), 3);
  monitor.stop();
});

Deno.test("EventLoopLagMonitor: reports the max over the rolling window and expires old samples", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor({
    ...timers.options,
    intervalMs: 100,
    windowMs: 1_000,
  });
  monitor.start();
  timers.fire(10);
  timers.fire(300);
  timers.fire(20);
  assertEquals(monitor.maxLagMs(), 300);

  // Move just past the 300 ms sample's expiry: only the 20 ms one remains.
  timers.advance(1_000 - 120 + 1);
  assertEquals(monitor.maxLagMs(), 20);

  timers.advance(1_000);
  assertEquals(monitor.maxLagMs(), undefined);
  monitor.stop();
});

Deno.test("EventLoopLagMonitor: keeps samples bounded by the window", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor({
    ...timers.options,
    intervalMs: 100,
    windowMs: 1_000,
  });
  monitor.start();
  timers.fire(1_000);
  for (let i = 0; i < 50; i++) timers.fire(1);
  // Fifty more firings 101 ms apart push the large sample out of the window.
  assertEquals(monitor.maxLagMs(), 1);
  monitor.stop();
});

Deno.test("EventLoopLagMonitor: stop clears the timer, reports undefined, and is idempotent", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor(timers.options);
  monitor.start();
  timers.fire(50);
  assertEquals(monitor.maxLagMs(), 50);

  monitor.stop();
  assertEquals(timers.cleared, [2]);
  assertEquals(timers.pending.size, 0);
  assertEquals(monitor.maxLagMs(), undefined);

  monitor.stop();
  assertEquals(timers.cleared, [2]);
  assertEquals(monitor.maxLagMs(), undefined);
});

Deno.test("EventLoopLagMonitor: start twice arms a single timer", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor(timers.options);
  monitor.start();
  monitor.start();
  assertEquals(timers.armed, [1]);
  assertEquals(timers.pending.size, 1);
  monitor.stop();
});

Deno.test("EventLoopLagMonitor: a restart after stop begins with no samples", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor(timers.options);
  monitor.start();
  timers.fire(70);
  monitor.stop();
  monitor.start();
  assertEquals(monitor.maxLagMs(), undefined);
  timers.fire(4);
  assertEquals(monitor.maxLagMs(), 4);
  monitor.stop();
});

Deno.test("EventLoopLagMonitor: a firing that races stop records nothing", () => {
  const timers = fakeTimers();
  const monitor = new EventLoopLagMonitor(timers.options);
  monitor.start();
  const [[, stale]] = [...timers.pending];
  monitor.stop();
  stale.fn();
  assertEquals(timers.armed, [1]);
  assertEquals(monitor.maxLagMs(), undefined);
});

Deno.test("EventLoopLagMonitor: real timers are released on stop", () => {
  const monitor = new EventLoopLagMonitor({ intervalMs: 10 });
  monitor.start();
  monitor.stop();
  assertEquals(monitor.maxLagMs(), undefined);
});
