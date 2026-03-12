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

import { assertEquals } from "@std/assert";
import { EventBus } from "./event_bus.ts";
import {
  createModelCreated,
  createModelDeleted,
  createModelUpdated,
  type ModelCreated,
  type ModelUpdated,
  type RepositoryEvent,
} from "./types.ts";

Deno.test("EventBus.subscribe and publish delivers events to handlers", async () => {
  const eventBus = new EventBus();
  const received: ModelCreated[] = [];

  eventBus.subscribe<ModelCreated>("ModelCreated", (event) => {
    received.push(event);
  });

  const event = createModelCreated("swamp/echo", "123", "my-model");
  await eventBus.publish(event);

  assertEquals(received.length, 1);
  assertEquals(received[0].modelType, "swamp/echo");
  assertEquals(received[0].modelInputId, "123");
  assertEquals(received[0].modelName, "my-model");
});

Deno.test("EventBus only delivers events to matching handlers", async () => {
  const eventBus = new EventBus();
  const created: ModelCreated[] = [];
  const updated: ModelUpdated[] = [];

  eventBus.subscribe<ModelCreated>("ModelCreated", (event) => {
    created.push(event);
  });
  eventBus.subscribe<ModelUpdated>("ModelUpdated", (event) => {
    updated.push(event);
  });

  await eventBus.publish(createModelCreated("swamp/echo", "1", "model-1"));
  await eventBus.publish(createModelUpdated("swamp/echo", "2", "model-2"));

  assertEquals(created.length, 1);
  assertEquals(updated.length, 1);
  assertEquals(created[0].modelInputId, "1");
  assertEquals(updated[0].modelInputId, "2");
});

Deno.test("EventBus.subscribeAll delivers all events", async () => {
  const eventBus = new EventBus();
  const received: RepositoryEvent[] = [];

  eventBus.subscribeAll((event) => {
    received.push(event);
  });

  await eventBus.publish(createModelCreated("swamp/echo", "1", "model-1"));
  await eventBus.publish(createModelUpdated("swamp/echo", "2", "model-2"));
  await eventBus.publish(createModelDeleted("swamp/echo", "3", "model-3"));

  assertEquals(received.length, 3);
  assertEquals(received[0].type, "ModelCreated");
  assertEquals(received[1].type, "ModelUpdated");
  assertEquals(received[2].type, "ModelDeleted");
});

Deno.test("EventBus.subscribe returns unsubscribe function", async () => {
  const eventBus = new EventBus();
  const received: ModelCreated[] = [];

  const unsubscribe = eventBus.subscribe<ModelCreated>(
    "ModelCreated",
    (event) => {
      received.push(event);
    },
  );

  await eventBus.publish(createModelCreated("swamp/echo", "1", "model-1"));
  assertEquals(received.length, 1);

  unsubscribe();

  await eventBus.publish(createModelCreated("swamp/echo", "2", "model-2"));
  assertEquals(received.length, 1); // Still 1, not 2
});

Deno.test("EventBus.batch queues events and dispatches at end", async () => {
  const eventBus = new EventBus();
  const received: ModelCreated[] = [];

  eventBus.subscribe<ModelCreated>("ModelCreated", (event) => {
    received.push(event);
  });

  await eventBus.batch(async () => {
    await eventBus.publish(createModelCreated("swamp/echo", "1", "model-1"));
    await eventBus.publish(createModelCreated("swamp/echo", "2", "model-2"));
    assertEquals(received.length, 0); // Not dispatched yet during batch
  });

  assertEquals(received.length, 2); // Dispatched after batch completes
});

Deno.test("EventBus.batch returns value from function", async () => {
  const eventBus = new EventBus();

  const result = await eventBus.batch(() => {
    return 42;
  });

  assertEquals(result, 42);
});

Deno.test("EventBus.isBatching reflects current state", async () => {
  const eventBus = new EventBus();

  assertEquals(eventBus.isBatching, false);

  await eventBus.batch(() => {
    assertEquals(eventBus.isBatching, true);
  });

  assertEquals(eventBus.isBatching, false);
});

Deno.test("EventBus handles async handlers", async () => {
  const eventBus = new EventBus();
  const received: string[] = [];

  eventBus.subscribe<ModelCreated>("ModelCreated", async (event) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    received.push(event.modelInputId);
  });

  await eventBus.publish(createModelCreated("swamp/echo", "1", "model-1"));

  assertEquals(received.length, 1);
  assertEquals(received[0], "1");
});

Deno.test("EventBus supports multiple handlers for same event", async () => {
  const eventBus = new EventBus();
  const received1: string[] = [];
  const received2: string[] = [];

  eventBus.subscribe<ModelCreated>("ModelCreated", (event) => {
    received1.push(event.modelInputId);
  });
  eventBus.subscribe<ModelCreated>("ModelCreated", (event) => {
    received2.push(event.modelInputId);
  });

  await eventBus.publish(createModelCreated("swamp/echo", "1", "model-1"));

  assertEquals(received1.length, 1);
  assertEquals(received2.length, 1);
});
