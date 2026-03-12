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

import { assertEquals, assertRejects, unreachable } from "@std/assert";
import type { SwampError } from "./errors.ts";
import {
  consumeStream,
  type EventHandlers,
  result,
  withDefaults,
} from "./stream.ts";

type TestEvent =
  | { kind: "started"; name: string }
  | { kind: "completed"; value: number }
  | { kind: "error"; error: SwampError };

async function* makeStream(
  events: TestEvent[],
): AsyncIterable<TestEvent> {
  for (const e of events) {
    yield e;
  }
}

Deno.test("consumeStream dispatches to correct handler per event", async () => {
  const received: string[] = [];
  await consumeStream<TestEvent>(
    makeStream([
      { kind: "started", name: "test" },
      { kind: "completed", value: 42 },
    ]),
    {
      started: (e) => {
        received.push(`started:${e.name}`);
      },
      completed: (e) => {
        received.push(`completed:${e.value}`);
      },
      error: () => {
        received.push("error");
      },
    },
  );
  assertEquals(received, ["started:test", "completed:42"]);
});

Deno.test("consumeStream awaits async handlers", async () => {
  const order: number[] = [];
  await consumeStream<TestEvent>(
    makeStream([
      { kind: "started", name: "a" },
      { kind: "completed", value: 1 },
    ]),
    {
      started: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      },
      completed: () => {
        order.push(2);
      },
      error: () => {},
    },
  );
  assertEquals(order, [1, 2]);
});

Deno.test("result returns completed event payload", async () => {
  const completed = await result<TestEvent>(
    makeStream([
      { kind: "started", name: "x" },
      { kind: "completed", value: 99 },
    ]),
  );
  assertEquals(completed, { kind: "completed", value: 99 });
});

Deno.test("result throws SwampError on error event", async () => {
  const err: SwampError = { code: "test_fail", message: "boom" };
  try {
    await result<TestEvent>(
      makeStream([
        { kind: "started", name: "x" },
        { kind: "error", error: err },
      ]),
    );
    unreachable();
  } catch (thrown) {
    const e = thrown as SwampError;
    assertEquals(e.code, "test_fail");
    assertEquals(e.message, "boom");
  }
});

Deno.test("result throws if stream ends without terminal", async () => {
  await assertRejects(
    async () => {
      await result<TestEvent>(makeStream([{ kind: "started", name: "x" }]));
    },
    Error,
    "Stream ended without a completed or error event",
  );
});

Deno.test("withDefaults fills missing handlers with no-ops", async () => {
  const received: string[] = [];
  const handlers: EventHandlers<TestEvent> = withDefaults<TestEvent>({
    completed: (e) => {
      received.push(`completed:${e.value}`);
    },
  });
  await consumeStream<TestEvent>(
    makeStream([
      { kind: "started", name: "ignored" },
      { kind: "completed", value: 7 },
    ]),
    handlers,
  );
  assertEquals(received, ["completed:7"]);
});

Deno.test("withDefaults with fallback calls fallback for unhandled events", async () => {
  const received: string[] = [];
  const handlers: EventHandlers<TestEvent> = withDefaults<TestEvent>(
    {
      completed: (e) => {
        received.push(`completed:${e.value}`);
      },
    },
    (event) => {
      received.push(`fallback:${event.kind}`);
    },
  );
  await consumeStream<TestEvent>(
    makeStream([
      { kind: "started", name: "x" },
      { kind: "completed", value: 5 },
    ]),
    handlers,
  );
  assertEquals(received, ["fallback:started", "completed:5"]);
});
