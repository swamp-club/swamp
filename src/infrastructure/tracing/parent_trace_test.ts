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
import { ROOT_CONTEXT } from "@opentelemetry/api";
import {
  runWithParentTrace,
  withGeneratorTraceContext,
} from "./parent_trace.ts";

Deno.test("runWithParentTrace: passes through when parentCtx is undefined", () => {
  const result = runWithParentTrace(undefined, () => 42);
  assertEquals(result, 42);
});

Deno.test("runWithParentTrace: runs fn within the given context", () => {
  const result = runWithParentTrace(ROOT_CONTEXT, () => "hello");
  assertEquals(result, "hello");
});

Deno.test("runWithParentTrace: propagates async return values", async () => {
  const result = await runWithParentTrace(
    ROOT_CONTEXT,
    () => Promise.resolve("async-value"),
  );
  assertEquals(result, "async-value");
});

// ============================================================================
// withGeneratorTraceContext Tests
// ============================================================================

Deno.test("withGeneratorTraceContext: passes through when traceparent is undefined", async () => {
  async function* source() {
    yield 1;
    yield 2;
    yield 3;
  }
  const results: number[] = [];
  for await (
    const value of withGeneratorTraceContext(undefined, undefined, source())
  ) {
    results.push(value);
  }
  assertEquals(results, [1, 2, 3]);
});

Deno.test("withGeneratorTraceContext: yields all values with traceparent set", async () => {
  async function* source() {
    yield "a";
    yield "b";
  }
  const results: string[] = [];
  for await (
    const value of withGeneratorTraceContext(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      undefined,
      source(),
    )
  ) {
    results.push(value);
  }
  assertEquals(results, ["a", "b"]);
});

Deno.test("withGeneratorTraceContext: handles empty generator", async () => {
  async function* source(): AsyncGenerator<never> {
    // empty
  }
  const results: never[] = [];
  for await (
    const value of withGeneratorTraceContext(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      "vendor=value",
      source(),
    )
  ) {
    results.push(value);
  }
  assertEquals(results, []);
});
