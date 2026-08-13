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
import { RunMetricsTracker } from "./run_metrics_tracker.ts";

Deno.test("RunMetricsTracker: snapshot returns zeros when no records", () => {
  const tracker = new RunMetricsTracker();
  const snap = tracker.snapshot();
  assertEquals(snap.completions, 0);
  assertEquals(snap.failures, 0);
  assertEquals(snap.cancellations, 0);
  assertEquals(snap.throughputPerMinute, 0);
  assertEquals(snap.latency.p50, 0);
  assertEquals(snap.latency.p95, 0);
  assertEquals(snap.latency.p99, 0);
});

Deno.test("RunMetricsTracker: counts completions, failures, and cancellations", () => {
  const tracker = new RunMetricsTracker();
  tracker.record("completed", 100);
  tracker.record("completed", 200);
  tracker.record("failed", 300);
  tracker.record("cancelled", 50);

  const snap = tracker.snapshot();
  assertEquals(snap.completions, 2);
  assertEquals(snap.failures, 1);
  assertEquals(snap.cancellations, 1);
});

Deno.test("RunMetricsTracker: computes latency percentiles", () => {
  const tracker = new RunMetricsTracker();
  for (let i = 1; i <= 100; i++) {
    tracker.record("completed", i * 10);
  }

  const snap = tracker.snapshot();
  assertEquals(snap.latency.p50, 500);
  assertEquals(snap.latency.p95, 950);
  assertEquals(snap.latency.p99, 990);
});

Deno.test("RunMetricsTracker: single record returns same value for all percentiles", () => {
  const tracker = new RunMetricsTracker();
  tracker.record("completed", 42);

  const snap = tracker.snapshot();
  assertEquals(snap.latency.p50, 42);
  assertEquals(snap.latency.p95, 42);
  assertEquals(snap.latency.p99, 42);
});

Deno.test("RunMetricsTracker: computes throughput per minute", () => {
  const windowMs = 60_000;
  const tracker = new RunMetricsTracker(windowMs);
  tracker.record("completed", 100);
  tracker.record("completed", 100);
  tracker.record("completed", 100);

  const snap = tracker.snapshot();
  assertEquals(snap.throughputPerMinute, 3);
});

Deno.test("RunMetricsTracker: window reports correct window size", () => {
  const windowMs = 120_000;
  const tracker = new RunMetricsTracker(windowMs);
  const snap = tracker.snapshot();
  assertEquals(snap.windowMs, 120_000);
});
