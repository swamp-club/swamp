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

import { assertEquals, assertRejects } from "@std/assert";
import { getTracer, withSpan } from "./tracer.ts";

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
