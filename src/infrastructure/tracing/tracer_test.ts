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

import { assertEquals, assertRejects } from "@std/assert";
import { getTracer, withGeneratorSpan, withSpan } from "./tracer.ts";

Deno.test("getTracer: returns a tracer instance", () => {
  const tracer = getTracer();
  // Should have startSpan method
  assertEquals(typeof tracer.startSpan, "function");
  assertEquals(typeof tracer.startActiveSpan, "function");
});

Deno.test("withSpan: returns the result of the wrapped function", async () => {
  const result = await withSpan(
    "test.span",
    { "test.key": "value" },
    () => Promise.resolve(42),
  );
  assertEquals(result, 42);
});

Deno.test("withSpan: propagates errors from the wrapped function", async () => {
  await assertRejects(
    () =>
      withSpan(
        "test.error.span",
        {},
        () => Promise.reject(new Error("test error")),
      ),
    Error,
    "test error",
  );
});

Deno.test("withSpan: handles non-Error throws", async () => {
  await assertRejects(
    () =>
      withSpan("test.string.throw", {}, () => Promise.reject("string error")),
  );
});

// ── withGeneratorSpan tests ─────────────────────────────────────────

async function collectEvents<T extends { kind: string }>(
  gen: AsyncIterable<T>,
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

Deno.test("withGeneratorSpan: yields all events from the inner generator", async () => {
  async function* inner() {
    yield { kind: "starting" as const };
    yield { kind: "completed" as const };
  }
  const events = await collectEvents(
    withGeneratorSpan("test.gen.span", {}, inner()),
  );
  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "starting");
  assertEquals(events[1].kind, "completed");
});

Deno.test("withGeneratorSpan: re-throws errors from the inner generator", async () => {
  async function* failing() {
    yield { kind: "starting" as const };
    throw new Error("cascade failed");
  }
  await assertRejects(
    () => collectEvents(withGeneratorSpan("test.gen.error", {}, failing())),
    Error,
    "cascade failed",
  );
});

Deno.test("withGeneratorSpan: propagates error kind events without throwing", async () => {
  async function* withError() {
    yield { kind: "error" as const, message: "something broke" };
  }
  const events = await collectEvents(
    withGeneratorSpan("test.gen.errorkind", {}, withError()),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
});
