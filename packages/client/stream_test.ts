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
import {
  consumeStream,
  result,
  SwampClientError,
  withDefaults,
} from "./stream.ts";
import type { SerializedError } from "./protocol.ts";

// ── Test event types ────────────────────────────────────────────────────

type TestEvent =
  | { kind: "started"; id: string }
  | { kind: "progress"; percent: number }
  | { kind: "completed"; result: string }
  | { kind: "error"; error: SerializedError };

/** Helper: creates an async iterable from an array. */
async function* asyncOf<T>(...items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

// ── SwampClientError ────────────────────────────────────────────────────

Deno.test("SwampClientError - constructor sets all fields", () => {
  const err = new SwampClientError("not_found", "Model not found", {
    id: "abc",
  });
  assertEquals(err.code, "not_found");
  assertEquals(err.message, "Model not found");
  assertEquals(err.details, { id: "abc" });
  assertEquals(err.name, "SwampClientError");
  assertEquals(err instanceof Error, true);
});

Deno.test("SwampClientError - details is optional", () => {
  const err = new SwampClientError("cancelled", "Cancelled");
  assertEquals(err.code, "cancelled");
  assertEquals(err.details, undefined);
});

// ── withDefaults ────────────────────────────────────────────────────────

Deno.test("withDefaults - provided handlers are used", () => {
  const calls: string[] = [];
  const handlers = withDefaults<TestEvent>({
    started: (e) => {
      calls.push(`started:${e.id}`);
    },
  });

  handlers.started({ kind: "started", id: "x" });
  assertEquals(calls, ["started:x"]);
});

Deno.test("withDefaults - missing handlers get noop", () => {
  const handlers = withDefaults<TestEvent>({});
  // Should not throw for unhandled kinds
  handlers.progress({ kind: "progress", percent: 50 });
  handlers.completed({ kind: "completed", result: "ok" });
});

Deno.test("withDefaults - fallback is called for missing handlers", () => {
  const fallbackCalls: string[] = [];
  const handlers = withDefaults<TestEvent>({}, (event) => {
    fallbackCalls.push(event.kind);
  });

  handlers.progress({ kind: "progress", percent: 50 });
  handlers.completed({ kind: "completed", result: "ok" });
  assertEquals(fallbackCalls, ["progress", "completed"]);
});

Deno.test("withDefaults - explicit handler takes precedence over fallback", () => {
  const calls: string[] = [];
  const handlers = withDefaults<TestEvent>(
    {
      started: () => {
        calls.push("explicit");
      },
    },
    () => {
      calls.push("fallback");
    },
  );

  handlers.started({ kind: "started", id: "1" });
  handlers.progress({ kind: "progress", percent: 0 });
  assertEquals(calls, ["explicit", "fallback"]);
});

// ── consumeStream ───────────────────────────────────────────────────────

Deno.test("consumeStream - dispatches all events to handlers", async () => {
  const events: TestEvent[] = [
    { kind: "started", id: "run-1" },
    { kind: "progress", percent: 50 },
    { kind: "completed", result: "done" },
  ];

  const seen: string[] = [];
  await consumeStream<TestEvent>(
    asyncOf(...events),
    withDefaults<TestEvent>({
      started: (e) => {
        seen.push(`started:${e.id}`);
      },
      progress: (e) => {
        seen.push(`progress:${e.percent}`);
      },
      completed: (e) => {
        seen.push(`completed:${e.result}`);
      },
    }),
  );

  assertEquals(seen, ["started:run-1", "progress:50", "completed:done"]);
});

Deno.test("consumeStream - works with async handlers", async () => {
  const events: TestEvent[] = [
    { kind: "started", id: "a" },
    { kind: "completed", result: "ok" },
  ];

  const seen: string[] = [];
  await consumeStream<TestEvent>(
    asyncOf(...events),
    withDefaults<TestEvent>({
      started: async (e) => {
        await Promise.resolve();
        seen.push(e.id);
      },
    }),
  );

  assertEquals(seen, ["a"]);
});

// ── result ──────────────────────────────────────────────────────────────

Deno.test("result - returns completed event", async () => {
  const events: TestEvent[] = [
    { kind: "started", id: "r1" },
    { kind: "progress", percent: 100 },
    { kind: "completed", result: "success" },
  ];

  const completed = await result<TestEvent>(asyncOf(...events));
  assertEquals(completed.kind, "completed");
  assertEquals(completed.result, "success");
});

Deno.test("result - throws SwampClientError on error event", async () => {
  const events: TestEvent[] = [
    { kind: "started", id: "r1" },
    {
      kind: "error",
      error: {
        code: "execution_failed",
        message: "Method threw",
        details: { exitCode: 1 },
      },
    },
  ];

  const err = await assertRejects(
    () => result<TestEvent>(asyncOf(...events)),
    SwampClientError,
    "Method threw",
  );
  assertEquals((err as SwampClientError).code, "execution_failed");
  assertEquals((err as SwampClientError).details, { exitCode: 1 });
});

Deno.test("result - throws generic Error if stream ends without terminal", async () => {
  const events: TestEvent[] = [
    { kind: "started", id: "r1" },
    { kind: "progress", percent: 50 },
  ];

  await assertRejects(
    () => result<TestEvent>(asyncOf(...events)),
    Error,
    "Stream ended without a completed or error event",
  );
});

Deno.test("result - skips non-terminal events", async () => {
  const events: TestEvent[] = [
    { kind: "started", id: "r1" },
    { kind: "progress", percent: 10 },
    { kind: "progress", percent: 50 },
    { kind: "progress", percent: 90 },
    { kind: "completed", result: "all done" },
  ];

  const completed = await result<TestEvent>(asyncOf(...events));
  assertEquals(completed.result, "all done");
});
