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
import { awaitSettlingRuns } from "./settling_runs.ts";

function settlingRun(): {
  run: { completion: Promise<void> };
  leave: () => void;
} {
  let leave!: () => void;
  const completion = new Promise<void>((resolve) => {
    leave = resolve;
  });
  return { run: { completion }, leave };
}

const NEVER = { completion: new Promise<void>(() => {}) };

// The large graces below also prove the timer is cleared: a timer left behind
// fails the test's op sanitizer.
Deno.test("awaitSettlingRuns: resolves once every run has left", async () => {
  const first = settlingRun();
  const second = settlingRun();
  let settled = false;
  const waiting = awaitSettlingRuns([first.run, second.run], {
    graceMs: 60_000,
  }).then(() => {
    settled = true;
  });

  first.leave();
  await Promise.resolve();
  assertEquals(settled, false);
  second.leave();
  await waiting;
  assertEquals(settled, true);
});

Deno.test("awaitSettlingRuns: resolves at once with no runs", async () => {
  await awaitSettlingRuns([], { graceMs: 60_000 });
});

Deno.test("awaitSettlingRuns: stops waiting when the grace passes", async () => {
  await awaitSettlingRuns([NEVER], { graceMs: 1 });
});

Deno.test("awaitSettlingRuns: stops waiting when the request aborts", async () => {
  const controller = new AbortController();
  const waiting = awaitSettlingRuns([NEVER], {
    graceMs: 60_000,
    signal: controller.signal,
  });
  controller.abort();
  await waiting;
});

Deno.test("awaitSettlingRuns: does not wait for an already aborted request", async () => {
  const controller = new AbortController();
  controller.abort();
  await awaitSettlingRuns([NEVER], {
    graceMs: 60_000,
    signal: controller.signal,
  });
});

Deno.test("awaitSettlingRuns: a run that ends in failure still counts as left", async () => {
  await awaitSettlingRuns([{ completion: Promise.reject(new Error("x")) }], {
    graceMs: 60_000,
  });
});
