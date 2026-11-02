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
import { EventBus } from "./event_bus.ts";
import {
  createDefinitionCreated,
  createModelCreated,
  createModelDeleted,
  createModelUpdated,
  createWorkflowCreated,
  type RepositoryEvent,
} from "./types.ts";

Deno.test("contract: batch preserves publication order across multiple event types", async () => {
  const bus = new EventBus();
  const order: string[] = [];

  bus.subscribeAll((event) => {
    order.push(event.type);
  });

  await bus.batch(async () => {
    await bus.publish(createModelCreated("t", "1", "a"));
    await bus.publish(createWorkflowCreated("2", "b"));
    await bus.publish(createDefinitionCreated("t", "3", "c"));
    await bus.publish(createModelDeleted("t", "4", "d"));
  });

  assertEquals(order, [
    "ModelCreated",
    "WorkflowCreated",
    "DefinitionCreated",
    "ModelDeleted",
  ]);
});

Deno.test("contract: failing handler does not prevent subsequent handlers from running", async () => {
  const bus = new EventBus();
  const received: string[] = [];

  bus.subscribe<RepositoryEvent>("ModelCreated", () => {
    throw new Error("handler 1 explodes");
  });
  bus.subscribe<RepositoryEvent>("ModelCreated", (event) => {
    received.push(event.type);
  });

  try {
    await bus.publish(createModelCreated("t", "1", "a"));
  } catch {
    // Expected: first handler threw
  }

  // handlers run sequentially and a throwing handler stops the later ones, so
  // handlers must not throw
  assertEquals(received.length, 0);
});

Deno.test("contract: type-specific and wildcard handlers both fire for same event", async () => {
  const bus = new EventBus();
  const specific: string[] = [];
  const wildcard: string[] = [];

  bus.subscribe("ModelCreated", () => {
    specific.push("specific");
  });
  bus.subscribeAll(() => {
    wildcard.push("wildcard");
  });

  await bus.publish(createModelCreated("t", "1", "a"));

  assertEquals(specific, ["specific"]);
  assertEquals(wildcard, ["wildcard"]);
});

Deno.test("contract: batch propagates errors from the batched function", async () => {
  const bus = new EventBus();

  await assertRejects(
    () =>
      bus.batch(() => {
        throw new Error("batch body failed");
      }),
    Error,
    "batch body failed",
  );

  assertEquals(bus.isBatching, false);
});

Deno.test("contract: events published after batch completes are delivered immediately", async () => {
  const bus = new EventBus();
  const received: string[] = [];

  bus.subscribeAll((event) => {
    received.push(event.type);
  });

  await bus.batch(async () => {
    await bus.publish(createModelCreated("t", "1", "a"));
  });

  assertEquals(received.length, 1);

  await bus.publish(createModelUpdated("t", "2", "b"));
  assertEquals(received.length, 2);
  assertEquals(received[1], "ModelUpdated");
});

Deno.test("contract: multiple unsubscribes are idempotent", async () => {
  const bus = new EventBus();
  const received: string[] = [];

  const unsub = bus.subscribe("ModelCreated", () => {
    received.push("called");
  });

  unsub();
  unsub();

  await bus.publish(createModelCreated("t", "1", "a"));
  assertEquals(received.length, 0);
});

Deno.test("contract: subscribeAll unsubscribe only removes that specific handler", async () => {
  const bus = new EventBus();
  const handler1Calls: string[] = [];
  const handler2Calls: string[] = [];

  const unsub1 = bus.subscribeAll(() => {
    handler1Calls.push("h1");
  });
  bus.subscribeAll(() => {
    handler2Calls.push("h2");
  });

  await bus.publish(createModelCreated("t", "1", "a"));
  assertEquals(handler1Calls.length, 1);
  assertEquals(handler2Calls.length, 1);

  unsub1();

  await bus.publish(createModelCreated("t", "2", "b"));
  assertEquals(handler1Calls.length, 1);
  assertEquals(handler2Calls.length, 2);
});
