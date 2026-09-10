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
import { AuditSinkTypeRegistry } from "./audit_sink_type_registry.ts";
import type { AuditSink } from "./audit_sink.ts";

function makeMockSink(name = "test"): AuditSink {
  return {
    name,
    durable: false,
    write: () => Promise.resolve(),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

Deno.test("AuditSinkTypeRegistry: register and create a sink", async () => {
  const registry = new AuditSinkTypeRegistry();
  const mockSink = makeMockSink();
  registry.register("test-sink", () => Promise.resolve(mockSink));

  const sink = await registry.createSink("test-sink", {});
  assertEquals(sink.name, "test");
  assertEquals(sink.durable, false);
});

Deno.test("AuditSinkTypeRegistry: createSink throws for unknown type", async () => {
  const registry = new AuditSinkTypeRegistry();

  await assertRejects(
    () => registry.createSink("nonexistent", {}),
    Error,
    'Unknown audit sink type: "nonexistent"',
  );
});

Deno.test("AuditSinkTypeRegistry: setLoader is called by ensureLoaded", async () => {
  const registry = new AuditSinkTypeRegistry();
  let loaderCalled = false;

  registry.setLoader(() => {
    loaderCalled = true;
    registry.register("lazy-sink", () => Promise.resolve(makeMockSink("lazy")));
    return Promise.resolve();
  });

  assertEquals(loaderCalled, false);
  await registry.ensureLoaded();
  assertEquals(loaderCalled, true);

  const sink = await registry.createSink("lazy-sink", {});
  assertEquals(sink.name, "lazy");
});

Deno.test("AuditSinkTypeRegistry: ensureLoaded only calls loader once", async () => {
  const registry = new AuditSinkTypeRegistry();
  let callCount = 0;

  registry.setLoader(() => {
    callCount++;
    return Promise.resolve();
  });

  await registry.ensureLoaded();
  await registry.ensureLoaded();
  await registry.ensureLoaded();
  assertEquals(callCount, 1);
});

Deno.test("AuditSinkTypeRegistry: has returns true for registered types", () => {
  const registry = new AuditSinkTypeRegistry();
  registry.register("present", () => Promise.resolve(makeMockSink()));

  assert(registry.has("present"));
  assert(!registry.has("absent"));
});

Deno.test("AuditSinkTypeRegistry: names returns registered type names", () => {
  const registry = new AuditSinkTypeRegistry();
  registry.register("alpha", () => Promise.resolve(makeMockSink()));
  registry.register("beta", () => Promise.resolve(makeMockSink()));

  const result = registry.names();
  assertEquals(result.length, 2);
  assert(result.includes("alpha"));
  assert(result.includes("beta"));
});

Deno.test("AuditSinkTypeRegistry: factory receives config", async () => {
  const registry = new AuditSinkTypeRegistry();
  let receivedConfig: Record<string, unknown> = {};

  registry.register("configurable", (config) => {
    receivedConfig = config;
    return Promise.resolve(makeMockSink());
  });

  await registry.createSink("configurable", { brokers: ["kafka:9092"] });
  assertEquals(receivedConfig, { brokers: ["kafka:9092"] });
});

Deno.test("AuditSinkTypeRegistry: setLoader resets loaded state", async () => {
  const registry = new AuditSinkTypeRegistry();
  let callCount = 0;

  registry.setLoader(() => {
    callCount++;
    return Promise.resolve();
  });
  await registry.ensureLoaded();
  assertEquals(callCount, 1);

  registry.setLoader(() => {
    callCount++;
    return Promise.resolve();
  });
  await registry.ensureLoaded();
  assertEquals(callCount, 2);
});
