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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { SpanKind } from "@opentelemetry/api";
import {
  getTracer,
  SpanStatusCode,
  withGeneratorSpan,
  withServerSpan,
  withSpan,
} from "./tracer.ts";
import { findSpan, isChildOf, withCapturedSpans } from "./span_test_helpers.ts";

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

// ── withServerSpan tests ────────────────────────────────────────────

Deno.test("withServerSpan: starts a SERVER span with the given attributes", async () => {
  await withCapturedSpans(async (spans) => {
    const result = await withServerSpan(
      "GET /ready",
      { "http.request.method": "GET" },
      () => Promise.resolve("ok"),
    );
    assertEquals(result, "ok");
    const span = findSpan(spans, "GET /ready");
    assertEquals(span.kind, SpanKind.SERVER);
    assertEquals(span.attributes["http.request.method"], "GET");
  });
});

Deno.test("withServerSpan: leaves status unset on success", async () => {
  await withCapturedSpans(async (spans) => {
    await withServerSpan("GET /ready", {}, () => Promise.resolve());
    assertEquals(
      findSpan(spans, "GET /ready").status.code,
      SpanStatusCode.UNSET,
    );
  });
});

Deno.test("withServerSpan: is a root span even inside an active parent span", async () => {
  await withCapturedSpans(async (spans) => {
    await withSpan("swamp.cli", {}, async () => {
      await withServerSpan("GET /ready", {}, () => Promise.resolve());
    });
    const cli = findSpan(spans, "swamp.cli");
    const server = findSpan(spans, "GET /ready");
    assertEquals(server.parentSpanId, undefined);
    assert(server.spanContext().traceId !== cli.spanContext().traceId);
  });
});

Deno.test("withServerSpan: is the active parent for spans started inside it", async () => {
  await withCapturedSpans(async (spans) => {
    await withServerSpan("POST /auth/device/token", {}, async () => {
      await Promise.resolve();
      await withSpan("child", {}, () => Promise.resolve());
    });
    assert(
      isChildOf(
        findSpan(spans, "child"),
        findSpan(spans, "POST /auth/device/token"),
      ),
    );
  });
});

Deno.test("withServerSpan: records a thrown error as ERROR and rethrows", async () => {
  await withCapturedSpans(async (spans) => {
    await assertRejects(
      () =>
        withServerSpan(
          "GET /ready",
          {},
          () => Promise.reject(new Error("boom")),
        ),
      Error,
      "boom",
    );
    const span = findSpan(spans, "GET /ready");
    assertEquals(span.status.code, SpanStatusCode.ERROR);
    assertEquals(span.status.message, "boom");
    assertEquals(span.events[0].name, "exception");
  });
});
