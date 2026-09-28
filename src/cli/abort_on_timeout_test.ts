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
import { abortOnTimeout } from "./abort_on_timeout.ts";

Deno.test("abortOnTimeout: aborts the controller with a timeout reason", async () => {
  const controller = new AbortController();
  const dispose = abortOnTimeout(controller, 1);
  try {
    await waitFor(
      () => controller.signal.aborted,
      "the timeout to abort the controller",
    );
    const reason = controller.signal.reason;
    assertEquals(reason instanceof DOMException, true);
    assertEquals(reason.name, "TimeoutError");
    assertEquals(reason.message, "The operation was aborted due to timeout");
  } finally {
    dispose();
  }
});

Deno.test("abortOnTimeout: a controller already aborted keeps its own reason", async () => {
  const controller = new AbortController();
  controller.abort();
  const timeout = AbortSignal.timeout(1);
  const dispose = abortOnTimeout(controller, 1);
  try {
    await waitFor(() => timeout.aborted, "the timeout to fire");
    assertEquals(controller.signal.reason.name, "AbortError");
  } finally {
    dispose();
  }
});

Deno.test("abortOnTimeout: a disposed timeout never aborts the controller", async () => {
  const controller = new AbortController();
  abortOnTimeout(controller, 1)();
  const later = AbortSignal.timeout(5);
  await waitFor(() => later.aborted, "a later timeout to fire");
  assertEquals(controller.signal.aborted, false);
});
