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
import { propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  runWithParentTrace,
  withGeneratorTraceContext,
} from "./parent_trace.ts";
import { getTracer } from "./tracer.ts";
import { findSpan, withRecordedSpans } from "./span_test_helpers.ts";

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

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
      TRACEPARENT,
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

// Workflow run, model run and workflow resume keep cleanup in finally blocks
// of the generators this wraps, which only run if an early exit reaches them.

Deno.test("withGeneratorTraceContext: a consumer break runs the inner finally once, inside the parent trace", async () => {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  try {
    await withRecordedSpans(async (recorder) => {
      let finallyRuns = 0;
      async function* source() {
        try {
          yield 1;
          yield 2;
        } finally {
          finallyRuns++;
          getTracer().startSpan("in-finally").end();
        }
      }

      for await (
        const _ of withGeneratorTraceContext(TRACEPARENT, undefined, source())
      ) {
        break;
      }

      // The break has resolved only after the inner finally ran.
      assertEquals(finallyRuns, 1);
      const inFinally = findSpan(recorder.ended, "in-finally");
      assertEquals(
        inFinally.spanContext().traceId,
        "0af7651916cd43dd8448eb211c80319c",
      );
      assertEquals(inFinally.parentSpanId, "b7ad6b7169203331");
    });
  } finally {
    propagation.disable();
  }
});

Deno.test("withGeneratorTraceContext: does not forward return() after the inner generator threw", async () => {
  let returnCalls = 0;
  async function* body() {
    yield 1;
    throw new Error("inner failed");
  }
  const inner = body();
  const originalReturn = inner.return.bind(inner);
  inner.return = (value) => {
    returnCalls++;
    return originalReturn(value);
  };

  await assertRejects(
    async () => {
      for await (
        const _ of withGeneratorTraceContext(TRACEPARENT, undefined, inner)
      ) {
        // drain
      }
    },
    Error,
    "inner failed",
  );
  assertEquals(returnCalls, 0);
});

Deno.test("withGeneratorTraceContext: does not forward return() once the inner generator completed", async () => {
  let returnCalls = 0;
  let finallyRuns = 0;
  async function* body() {
    try {
      yield 1;
    } finally {
      finallyRuns++;
    }
  }
  const inner = body();
  const originalReturn = inner.return.bind(inner);
  inner.return = (value) => {
    returnCalls++;
    return originalReturn(value);
  };

  const gen = withGeneratorTraceContext(TRACEPARENT, undefined, inner);
  assertEquals(await gen.next(), { value: 1, done: false });
  assertEquals((await gen.next()).done, true);
  await gen.return(undefined);

  assertEquals(finallyRuns, 1);
  assertEquals(returnCalls, 0);
});
