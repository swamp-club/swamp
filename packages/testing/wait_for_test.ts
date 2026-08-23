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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { waitFor } from "./wait_for.ts";

Deno.test("waitFor: returns immediately when condition already holds", async () => {
  let checks = 0;
  await waitFor(() => {
    checks++;
    return true;
  }, "already-true condition");
  assertEquals(checks, 1);
});

Deno.test("waitFor: polls until the condition becomes true", async () => {
  let ready = false;
  const timer = setTimeout(() => {
    ready = true;
  }, 50);
  try {
    await waitFor(() => ready, "flag flip", { intervalMs: 5 });
    assertEquals(ready, true);
  } finally {
    clearTimeout(timer);
  }
});

Deno.test("waitFor: supports async conditions", async () => {
  let calls = 0;
  await waitFor(
    () => {
      calls++;
      return Promise.resolve(calls >= 3);
    },
    "third async check",
    { intervalMs: 5 },
  );
  assertEquals(calls, 3);
});

Deno.test("waitFor: throws with the description after the deadline", async () => {
  const error = await assertRejects(
    () =>
      waitFor(() => false, "an event that never fires", {
        timeoutMs: 50,
        intervalMs: 5,
      }),
    Error,
  );
  assertStringIncludes(error.message, "an event that never fires");
  assertStringIncludes(error.message, "50ms");
});
