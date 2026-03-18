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
import { withEventBridge } from "./event_bridge.ts";

Deno.test("withEventBridge yields events and returns result", async () => {
  const events: string[] = [];

  async function* run() {
    const result = yield* withEventBridge<string, number>((push) => {
      push("a");
      push("b");
      return Promise.resolve(42);
    });
    return result;
  }

  const gen = run();
  for await (const event of gen) {
    events.push(event);
  }

  assertEquals(events, ["a", "b"]);
});

Deno.test("withEventBridge captures return value via yield*", async () => {
  async function* run(): AsyncGenerator<string, number> {
    const result = yield* withEventBridge<string, number>((push) => {
      push("event");
      return Promise.resolve(99);
    });
    return result;
  }

  const gen = run();
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
  const lastValue = result.value;

  assertEquals(lastValue, 99);
});

Deno.test("withEventBridge propagates errors", async () => {
  async function* run() {
    yield* withEventBridge<string, void>((_push) => {
      return Promise.reject(new Error("test error"));
    });
  }

  const events: string[] = [];
  await assertRejects(
    async () => {
      for await (const event of run()) {
        events.push(event);
      }
    },
    Error,
    "test error",
  );
  assertEquals(events, []);
});

Deno.test("withEventBridge streams events during async work", async () => {
  const events: number[] = [];

  async function* run() {
    yield* withEventBridge<number, void>(async (push) => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 1));
        push(i);
      }
    });
  }

  for await (const event of run()) {
    events.push(event);
  }

  assertEquals(events, [0, 1, 2]);
});

Deno.test("withEventBridge handles zero events", async () => {
  const events: string[] = [];

  async function* run() {
    const result = yield* withEventBridge<string, string>((_push) => {
      return Promise.resolve("done");
    });
    return result;
  }

  const gen = run();
  let result = await gen.next();
  while (!result.done) {
    events.push(result.value);
    result = await gen.next();
  }

  assertEquals(events, []);
  assertEquals(result.value, "done");
});

Deno.test("withEventBridge handles push after error gracefully", async () => {
  // If the callback pushes events then rejects, events before the
  // rejection should still be yielded and the error should propagate.
  const events: string[] = [];

  async function* run() {
    yield* withEventBridge<string, void>((push) => {
      push("before-error");
      return Promise.reject(new Error("fail after push"));
    });
  }

  await assertRejects(
    async () => {
      for await (const event of run()) {
        events.push(event);
      }
    },
    Error,
    "fail after push",
  );
  assertEquals(events, ["before-error"]);
});
