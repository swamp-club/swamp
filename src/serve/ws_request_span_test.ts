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

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { SpanStatusCode, withSpan } from "../infrastructure/tracing/mod.ts";
import {
  findSpan,
  isChildOf,
  SpanKind,
  withCapturedSpans,
} from "../infrastructure/tracing/span_test_helpers.ts";
import {
  connectionIdOf,
  type EventLoopLagReader,
  traceWebSocketRequest,
  type WebSocketRequestTrace,
} from "./ws_request_span.ts";

function fakeSocket(): WebSocket {
  return { readyState: 1, send: () => {} } as unknown as WebSocket;
}

function makeTrace(
  overrides: Partial<WebSocketRequestTrace> = {},
): WebSocketRequestTrace {
  return {
    type: "workflow.history.get",
    socket: fakeSocket(),
    activeRequests: 1,
    principal: null,
    datastoreType: "filesystem",
    datastoreEngine: "files",
    ...overrides,
  };
}

function lagReader(value: number | undefined): EventLoopLagReader {
  return { maxLagMs: () => value };
}

Deno.test("connectionIdOf: returns one id per socket", () => {
  const a = fakeSocket();
  const b = fakeSocket();
  assertEquals(connectionIdOf(a), connectionIdOf(a));
  assertNotEquals(connectionIdOf(a), connectionIdOf(b));
});

Deno.test("traceWebSocketRequest: opens a root SERVER span with the request attributes", async () => {
  await withCapturedSpans(async (spans) => {
    const trace = makeTrace({
      type: "workflow.run.search",
      activeRequests: 3,
      datastoreType: "s3",
      datastoreEngine: "sqlite",
    });
    await traceWebSocketRequest(trace, () => Promise.resolve());

    const span = findSpan(spans, "swamp.serve.request");
    assertEquals(span.kind, SpanKind.SERVER);
    assertEquals(span.parentSpanId, undefined);
    assertEquals(span.status.code, SpanStatusCode.UNSET);
    assertEquals(
      span.attributes["swamp.serve.request.type"],
      "workflow.run.search",
    );
    assertEquals(
      span.attributes["swamp.serve.connection.id"],
      connectionIdOf(trace.socket),
    );
    assertEquals(span.attributes["swamp.serve.active_requests"], 3);
    assertEquals(span.attributes["datastore.type"], "s3");
    assertEquals(span.attributes["datastore.engine"], "sqlite");
  });
});

Deno.test("traceWebSocketRequest: stays a root span when called inside another span", async () => {
  await withCapturedSpans(async (spans) => {
    await withSpan(
      "test.ambient",
      {},
      () => traceWebSocketRequest(makeTrace(), () => Promise.resolve()),
    );

    const ambient = findSpan(spans, "test.ambient");
    const span = findSpan(spans, "swamp.serve.request");
    assertEquals(span.parentSpanId, undefined);
    assertNotEquals(
      span.spanContext().traceId,
      ambient.spanContext().traceId,
    );
  });
});

Deno.test("traceWebSocketRequest: records anonymous with no principal id when unauthenticated", async () => {
  await withCapturedSpans(async (spans) => {
    await traceWebSocketRequest(makeTrace(), () => Promise.resolve());

    const span = findSpan(spans, "swamp.serve.request");
    assertEquals(span.attributes["auth.principal.kind"], "anonymous");
    assertEquals(span.attributes["auth.principal.id"], undefined);
  });
});

Deno.test("traceWebSocketRequest: records the principal kind and id", async () => {
  await withCapturedSpans(async (spans) => {
    await traceWebSocketRequest(
      makeTrace({ principal: { kind: "user", id: "adam" } }),
      () => Promise.resolve(),
    );

    const span = findSpan(spans, "swamp.serve.request");
    assertEquals(span.attributes["auth.principal.kind"], "user");
    assertEquals(span.attributes["auth.principal.id"], "user:adam");
  });
});

Deno.test("traceWebSocketRequest: two requests on one socket share a connection id", async () => {
  await withCapturedSpans(async (spans) => {
    const shared = fakeSocket();
    const other = fakeSocket();
    await traceWebSocketRequest(
      makeTrace({ socket: shared, type: "a" }),
      () => Promise.resolve(),
    );
    await traceWebSocketRequest(
      makeTrace({ socket: shared, type: "b" }),
      () => Promise.resolve(),
    );
    await traceWebSocketRequest(
      makeTrace({ socket: other, type: "c" }),
      () => Promise.resolve(),
    );

    const idOf = (type: string) =>
      spans.find((s) =>
        s.name === "swamp.serve.request" &&
        s.attributes["swamp.serve.request.type"] === type
      )?.attributes["swamp.serve.connection.id"];
    assert(idOf("a") !== undefined);
    assertEquals(idOf("a"), idOf("b"));
    assertNotEquals(idOf("a"), idOf("c"));
  });
});

Deno.test("traceWebSocketRequest: a span started inside fn is its child", async () => {
  await withCapturedSpans(async (spans) => {
    await traceWebSocketRequest(
      makeTrace(),
      () => withSpan("test.lookup", {}, () => Promise.resolve()),
    );

    const request = findSpan(spans, "swamp.serve.request");
    const lookup = findSpan(spans, "test.lookup");
    assert(isChildOf(lookup, request));
  });
});

Deno.test("traceWebSocketRequest: records the event-loop lag the reader reports", async () => {
  await withCapturedSpans(async (spans) => {
    await traceWebSocketRequest(
      makeTrace({ eventLoopLag: lagReader(42) }),
      () => Promise.resolve(),
    );

    const span = findSpan(spans, "swamp.serve.request");
    assertEquals(span.attributes["swamp.serve.event_loop.lag_max_ms"], 42);
  });
});

Deno.test("traceWebSocketRequest: records no lag when the reader has none", async () => {
  await withCapturedSpans(async (spans) => {
    await traceWebSocketRequest(
      makeTrace({ type: "a", eventLoopLag: lagReader(undefined) }),
      () => Promise.resolve(),
    );
    await traceWebSocketRequest(
      makeTrace({ type: "b" }),
      () => Promise.resolve(),
    );

    const requests = spans.filter((s) => s.name === "swamp.serve.request");
    assertEquals(requests.length, 2);
    for (const span of requests) {
      assertEquals(
        span.attributes["swamp.serve.event_loop.lag_max_ms"],
        undefined,
      );
    }
  });
});

Deno.test("traceWebSocketRequest: a rejecting fn rejects and marks the span ERROR", async () => {
  await withCapturedSpans(async (spans) => {
    await assertRejects(
      () =>
        traceWebSocketRequest(
          makeTrace({ eventLoopLag: lagReader(7) }),
          () => Promise.reject(new Error("handler failed")),
        ),
      Error,
      "handler failed",
    );

    const span = findSpan(spans, "swamp.serve.request");
    assertEquals(span.status.code, SpanStatusCode.ERROR);
    assertEquals(span.status.message, "handler failed");
    assertEquals(span.attributes["swamp.serve.event_loop.lag_max_ms"], 7);
  });
});
