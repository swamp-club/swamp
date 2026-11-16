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
  cancelCause,
  CLEANUP_GRACE_TIMEOUT_MS,
} from "../models/cancel_cause.ts";
import {
  isInterruption,
  RunInterruption,
  stopGraceFor,
} from "./run_interruption.ts";

Deno.test("isInterruption: true for a signal aborted with a RunInterruption", () => {
  const controller = new AbortController();
  controller.abort(new RunInterruption("server_shutdown"));
  assertEquals(isInterruption(controller.signal), true);
});

Deno.test("isInterruption: false for an unaborted signal, a missing one, or another reason", () => {
  assertEquals(isInterruption(undefined), false);
  assertEquals(isInterruption(new AbortController().signal), false);
  const cancelled = new AbortController();
  cancelled.abort(new Error("server shutdown"));
  assertEquals(isInterruption(cancelled.signal), false);
  const plain = new AbortController();
  plain.abort();
  assertEquals(isInterruption(plain.signal), false);
});

Deno.test("isInterruption: a signal combined with AbortSignal.any keeps the reason", () => {
  const run = new AbortController();
  const combined = AbortSignal.any([run.signal, new AbortController().signal]);
  run.abort(new RunInterruption("server_shutdown"));
  assertEquals(isInterruption(combined), true);
});

Deno.test("RunInterruption: carries its reason and reads as the cancel cause", () => {
  const interruption = new RunInterruption("server_shutdown");
  assertEquals(interruption.interruptReason, "server_shutdown");
  const controller = new AbortController();
  controller.abort(interruption);
  assertEquals(cancelCause(controller.signal), "server shutdown");
});

Deno.test("stopGraceFor: the abort grace while no run was cancelled before the stop", () => {
  assertEquals(stopGraceFor([], 5_000), 5_000);
  assertEquals(
    stopGraceFor([{ controller: new AbortController() }], 5_000),
    5_000,
  );
});

Deno.test("stopGraceFor: one cleanup grace more while a run cancelled before the stop is still in flight", () => {
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled by user"));
  assertEquals(
    stopGraceFor(
      [{ controller: new AbortController() }, { controller: cancelled }],
      5_000,
    ),
    CLEANUP_GRACE_TIMEOUT_MS + 5_000,
  );
});
