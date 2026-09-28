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
import { type Span, SpanKind, trace } from "@opentelemetry/api";
import {
  bindGeneratorToSpan,
  getTracer,
  SpanStatusCode,
  withGeneratorSpan,
  withServerSpan,
  withSpan,
} from "./tracer.ts";
import {
  findSpan,
  isChildOf,
  withCapturedSpans,
  withRecordedSpans,
} from "./span_test_helpers.ts";

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

// ── bindGeneratorToSpan tests ───────────────────────────────────────

Deno.test("bindGeneratorToSpan: spans started in the generator are children of the bound span", async () => {
  await withRecordedSpans(async (recorder) => {
    const bound = getTracer().startSpan("bound");
    async function* inner() {
      getTracer().startSpan("before-yield").end();
      yield 1;
      getTracer().startSpan("after-yield").end();
      await Promise.resolve();
      getTracer().startSpan("after-await").end();
      yield 2;
    }

    const activeInConsumer: (Span | undefined)[] = [];
    const values: number[] = [];
    for await (const value of bindGeneratorToSpan(bound, inner())) {
      values.push(value);
      activeInConsumer.push(trace.getActiveSpan());
    }

    assertEquals(values, [1, 2]);
    for (const name of ["before-yield", "after-yield", "after-await"]) {
      assertEquals(
        findSpan(recorder.ended, name).parentSpanId,
        bound.spanContext().spanId,
      );
    }
    // The bound span is active only inside the generator, never in the
    // consumer or after iteration.
    assertEquals(activeInConsumer, [undefined, undefined]);
    assertEquals(trace.getActiveSpan(), undefined);
    // The caller owns the span's lifecycle.
    assertEquals(recorder.ended.some((s) => s.name === "bound"), false);
    bound.end();
  });
});

Deno.test("bindGeneratorToSpan: passes the inner return value through", async () => {
  async function* inner(): AsyncGenerator<number, string> {
    yield 1;
    return "result";
  }
  async function* outer(): AsyncGenerator<number, string> {
    return yield* bindGeneratorToSpan(getTracer().startSpan("bound"), inner());
  }
  const gen = outer();
  assertEquals(await gen.next(), { value: 1, done: false });
  assertEquals(await gen.next(), { value: "result", done: true });
});

Deno.test("bindGeneratorToSpan: propagates an error thrown by the inner generator", async () => {
  let returnCalls = 0;
  async function* failing() {
    yield 1;
    throw new Error("inner failed");
  }
  const inner = failing();
  const originalReturn = inner.return.bind(inner);
  inner.return = (value) => {
    returnCalls++;
    return originalReturn(value);
  };

  await assertRejects(
    async () => {
      for await (
        const _ of bindGeneratorToSpan(getTracer().startSpan("bound"), inner)
      ) {
        // drain
      }
    },
    Error,
    "inner failed",
  );
  // The inner generator already finished by throwing; nothing to forward.
  assertEquals(returnCalls, 0);
});

// The workflow execution service relies on these: its run, job and step
// generators release the run log sink, remote affinity and their spans in
// finally blocks, which only run if an early exit reaches them.

Deno.test("bindGeneratorToSpan: a consumer break runs the inner finally once, inside the span context", async () => {
  await withRecordedSpans(async (recorder) => {
    const bound = getTracer().startSpan("bound");
    let finallyRuns = 0;
    async function* inner() {
      try {
        yield 1;
        yield 2;
      } finally {
        finallyRuns++;
        getTracer().startSpan("in-finally").end();
      }
    }

    for await (const _ of bindGeneratorToSpan(bound, inner())) {
      break;
    }

    // The break has resolved only after the inner finally ran.
    assertEquals(finallyRuns, 1);
    assertEquals(
      findSpan(recorder.ended, "in-finally").parentSpanId,
      bound.spanContext().spanId,
    );
    bound.end();
  });
});

Deno.test("bindGeneratorToSpan: a break unwinds nested layers innermost first", async () => {
  await withRecordedSpans(async (recorder) => {
    const unwound: string[] = [];
    const runSpan = getTracer().startSpan("run");

    async function* step() {
      try {
        yield "event";
        yield "never";
      } finally {
        unwound.push("step");
      }
    }
    async function* job() {
      try {
        const stepSpan = getTracer().startSpan("step");
        try {
          yield* bindGeneratorToSpan(stepSpan, step());
        } finally {
          stepSpan.end();
        }
      } finally {
        unwound.push("job");
      }
    }
    async function* run() {
      try {
        const jobSpan = getTracer().startSpan("job");
        try {
          yield* bindGeneratorToSpan(jobSpan, job());
        } finally {
          jobSpan.end();
        }
      } finally {
        unwound.push("run");
      }
    }

    for await (const _ of bindGeneratorToSpan(runSpan, run())) {
      break;
    }
    runSpan.end();

    assertEquals(unwound, ["step", "job", "run"]);
    // Every span the layers started was ended, and they nest.
    assertEquals(recorder.started.length, recorder.ended.length);
    assertEquals(
      findSpan(recorder.ended, "job").parentSpanId,
      runSpan.spanContext().spanId,
    );
    assertEquals(
      findSpan(recorder.ended, "step").parentSpanId,
      findSpan(recorder.ended, "job").spanContext().spanId,
    );
  });
});

Deno.test("bindGeneratorToSpan: does not forward return() once the inner generator completed", async () => {
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

  const gen = bindGeneratorToSpan(getTracer().startSpan("bound"), inner);
  assertEquals(await gen.next(), { value: 1, done: false });
  assertEquals((await gen.next()).done, true);
  await gen.return(undefined);

  assertEquals(finallyRuns, 1);
  assertEquals(returnCalls, 0);
});

Deno.test("bindGeneratorToSpan: an error from the inner finally surfaces to the consumer", async () => {
  async function* inner() {
    try {
      yield 1;
    } finally {
      // deno-lint-ignore no-unsafe-finally
      throw new Error("cleanup failed");
    }
  }

  await assertRejects(
    async () => {
      for await (
        const _ of bindGeneratorToSpan(getTracer().startSpan("bound"), inner())
      ) {
        break;
      }
    },
    Error,
    "cleanup failed",
  );
});

Deno.test("bindGeneratorToSpan: forwards an early break with no tracer registered", async () => {
  // Tracing is off for most runs, so the no-op span and context must still
  // unwind every layer.
  const unwound: string[] = [];
  async function* innermost() {
    try {
      yield 1;
      yield 2;
    } finally {
      unwound.push("inner");
    }
  }
  async function* middle() {
    try {
      yield* bindGeneratorToSpan(getTracer().startSpan("middle"), innermost());
    } finally {
      unwound.push("middle");
    }
  }

  for await (
    const _ of bindGeneratorToSpan(getTracer().startSpan("outer"), middle())
  ) {
    break;
  }

  assertEquals(unwound, ["inner", "middle"]);
});
