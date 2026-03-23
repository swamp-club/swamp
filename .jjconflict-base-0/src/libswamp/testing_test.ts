// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import type { SwampError } from "./errors.ts";
import { assertCompletes, assertErrors, collect } from "./testing.ts";

type SimpleEvent =
  | { kind: "progress"; pct: number }
  | { kind: "completed"; result: string }
  | { kind: "error"; error: SwampError };

async function* makeStream(
  events: SimpleEvent[],
): AsyncIterable<SimpleEvent> {
  for (const e of events) {
    yield e;
  }
}

Deno.test("collect accumulates all events", async () => {
  const events = await collect(
    makeStream([
      { kind: "progress", pct: 50 },
      { kind: "completed", result: "done" },
    ]),
  );
  assertEquals(events, [
    { kind: "progress", pct: 50 },
    { kind: "completed", result: "done" },
  ]);
});

Deno.test("collect returns empty array for empty stream", async () => {
  const events = await collect(makeStream([]));
  assertEquals(events, []);
});

Deno.test("assertCompletes succeeds when stream ends with expected completed event", async () => {
  const completed = await assertCompletes<SimpleEvent>(
    makeStream([
      { kind: "progress", pct: 100 },
      { kind: "completed", result: "ok" },
    ]),
    { kind: "completed", result: "ok" },
  );
  assertEquals(completed, { kind: "completed", result: "ok" });
});

Deno.test("assertErrors succeeds when stream ends with expected error code", async () => {
  const error = await assertErrors<SimpleEvent>(
    makeStream([
      { kind: "error", error: { code: "test_error", message: "oops" } },
    ]),
    "test_error",
  );
  assertEquals(error.code, "test_error");
  assertEquals(error.message, "oops");
});
