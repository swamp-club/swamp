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
import {
  nextRefetch,
  RUN_ACTIVITY_REFETCH_MS,
  runActivityChanged,
} from "./run_activity.ts";

const T0 = Date.UTC(2026, 9, 14, 16, 0, 0);
const WINDOW = RUN_ACTIVITY_REFETCH_MS;

Deno.test("runActivityChanged: a run starting or stopping is a change", () => {
  const idle = { activityKey: "", visible: true };
  assertEquals(runActivityChanged(idle, { ...idle, activityKey: "r1" }), true);
  assertEquals(
    runActivityChanged({ ...idle, activityKey: "r1" }, idle),
    true,
  );
  assertEquals(runActivityChanged(idle, { ...idle }), false);
});

Deno.test("runActivityChanged: coming into view is a change, leaving is not", () => {
  const shown = { activityKey: "r1", visible: true };
  const hidden = { activityKey: "r1", visible: false };
  assertEquals(runActivityChanged(hidden, shown), true);
  assertEquals(runActivityChanged(shown, hidden), false);
  assertEquals(runActivityChanged(hidden, hidden), false);
});

Deno.test("nextRefetch: nothing without a pending change", () => {
  assertEquals(
    nextRefetch({ lastAt: T0, pending: false, visible: true }, T0 + WINDOW * 9),
    { kind: "none" },
  );
});

Deno.test("nextRefetch: a change after a quiet window refetches now", () => {
  assertEquals(
    nextRefetch({ lastAt: T0, pending: true, visible: true }, T0 + WINDOW),
    { kind: "now" },
  );
});

Deno.test("nextRefetch: a change inside the window waits for its end", () => {
  // The first load counts as a fetch: a tab opened in the background and
  // shown a moment later does not fetch twice.
  assertEquals(
    nextRefetch({ lastAt: T0, pending: true, visible: true }, T0 + 2_000),
    { kind: "at", at: T0 + WINDOW },
  );
});

Deno.test("nextRefetch: a burst of changes costs one refetch per window", () => {
  let state = { lastAt: T0, pending: false };
  let refetches = 0;
  // A run starts or finishes every 5 s (each health snapshot) for 2 min.
  for (let now = T0 + 5_000; now <= T0 + 120_000; now += 5_000) {
    state.pending = true;
    const step = nextRefetch({ ...state, visible: true }, now);
    if (step.kind === "now") {
      state = { lastAt: now, pending: false };
      refetches++;
    }
  }
  assertEquals(refetches, 120_000 / WINDOW);
});

Deno.test("nextRefetch: a hidden tab holds the change until it is shown", () => {
  const pending = { lastAt: T0, pending: true };
  assertEquals(
    nextRefetch({ ...pending, visible: false }, T0 + WINDOW * 10),
    { kind: "hold" },
  );
  assertEquals(
    nextRefetch({ ...pending, visible: true }, T0 + WINDOW * 10),
    { kind: "now" },
  );
});

Deno.test("nextRefetch: switching tabs quickly still costs one refetch per window", () => {
  let state = { lastAt: T0 - WINDOW, pending: false };
  let refetches = 0;
  // Shown every second for a minute: each show is a pending change.
  for (let now = T0; now < T0 + 60_000; now += 1_000) {
    state.pending = true;
    if (nextRefetch({ ...state, visible: true }, now).kind === "now") {
      state = { lastAt: now, pending: false };
      refetches++;
    }
  }
  assertEquals(refetches, 60_000 / WINDOW);
});
