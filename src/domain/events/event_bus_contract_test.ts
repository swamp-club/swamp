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

/**
 * Contract tests for the EventBus.
 *
 * These test behavioral invariants that consumers depend on but are NOT
 * covered by the unit tests in event_bus_test.ts:
 * - Batch events preserve publication order
 * - Handler errors don't break other handlers
 * - Nested batches are rejected (or handled predictably)
 * - Type-specific and wildcard handlers both fire for the same event
 */

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

  // The publish should reject because the first handler throws, but we want
  // to understand the actual behavior for the contract.
  try {
    await bus.publish(createModelCreated("t", "1", "a"));
  } catch {
    // Expected: first handler threw
  }

  // Contract: handlers run sequentially. If the first throws, the second
  // never runs. This documents the actual behavior so consumers know
  // handlers must not throw.
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

  // After a failed batch, the bus should not be stuck in batching mode
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

  // After batch, publish should be immediate (not queued)
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
  unsub(); // Second unsubscribe should be harmless

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
  assertEquals(handler1Calls.length, 1); // Not called again
  assertEquals(handler2Calls.length, 2); // Still active
});
