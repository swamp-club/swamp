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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  cancelCause,
  CLEANUP_GRACE_EXPIRED_CAUSE,
  cleanupGraceSignal,
  TIMED_OUT_CAUSE,
} from "./cancel_cause.ts";

function abortedWith(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

Deno.test("cancelCause: a signal that has not aborted has no cause", () => {
  assertEquals(cancelCause(new AbortController().signal), undefined);
});

Deno.test("cancelCause: an abort with no reason has no cause", () => {
  assertEquals(cancelCause(abortedWith()), undefined);
});

Deno.test("cancelCause: an AbortError reason has no cause", () => {
  assertEquals(
    cancelCause(
      abortedWith(new DOMException("The operation was aborted.", "AbortError")),
    ),
    undefined,
  );
});

Deno.test("cancelCause: a reason that is not an Error has no cause", () => {
  assertEquals(cancelCause(abortedWith("stop")), undefined);
});

Deno.test("cancelCause: a TimeoutError reason is a timeout", () => {
  assertEquals(
    cancelCause(
      abortedWith(new DOMException("Signal timed out.", "TimeoutError")),
    ),
    TIMED_OUT_CAUSE,
  );
});

Deno.test("cancelCause: a timeout carried through AbortSignal.any is a timeout", () => {
  const signal = AbortSignal.any([
    new AbortController().signal,
    abortedWith(new DOMException("Signal timed out.", "TimeoutError")),
  ]);
  assertEquals(cancelCause(signal), TIMED_OUT_CAUSE);
});

Deno.test("cancelCause: a named reason is passed through", () => {
  assertEquals(
    cancelCause(abortedWith(new Error("No longer needed"))),
    "No longer needed",
  );
});

Deno.test("cancelCause: an Error reason with an empty message has no cause", () => {
  assertEquals(cancelCause(abortedWith(new Error(""))), undefined);
});

Deno.test("cleanupGraceSignal: has no cause until the grace runs out", () => {
  assertEquals(cancelCause(cleanupGraceSignal(60_000)), undefined);
});

Deno.test("cleanupGraceSignal: an expired grace is its own cause", async () => {
  const signal = cleanupGraceSignal(1);
  await waitFor(() => signal.aborted, "the grace to run out");
  assertEquals(cancelCause(signal), CLEANUP_GRACE_EXPIRED_CAUSE);
});

Deno.test("cleanupGraceSignal: a signal derived from an expired grace reads as a timeout", async () => {
  const grace = cleanupGraceSignal(1);
  await waitFor(() => grace.aborted, "the grace to run out");
  const derived = AbortSignal.any([grace, new AbortController().signal]);
  assertEquals(cancelCause(derived), TIMED_OUT_CAUSE);
});
