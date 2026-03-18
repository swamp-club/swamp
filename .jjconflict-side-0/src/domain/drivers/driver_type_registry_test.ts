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

import { assertEquals, assertThrows } from "@std/assert";
import { DriverTypeRegistry } from "./driver_type_registry.ts";

Deno.test("DriverTypeRegistry - register and get", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "test-driver",
    name: "Test Driver",
    description: "A test driver",
    isBuiltIn: true,
  });

  const info = registry.get("test-driver");
  assertEquals(info?.type, "test-driver");
  assertEquals(info?.name, "Test Driver");
  assertEquals(info?.isBuiltIn, true);
});

Deno.test("DriverTypeRegistry - get is case-insensitive", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "My-Driver",
    name: "My Driver",
    description: "A driver",
    isBuiltIn: false,
  });

  assertEquals(registry.get("my-driver")?.type, "My-Driver");
  assertEquals(registry.get("MY-DRIVER")?.type, "My-Driver");
});

Deno.test("DriverTypeRegistry - get returns undefined for unknown type", () => {
  const registry = new DriverTypeRegistry();
  assertEquals(registry.get("nonexistent"), undefined);
});

Deno.test("DriverTypeRegistry - has returns true for registered type", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "test-driver",
    name: "Test",
    description: "test",
    isBuiltIn: true,
  });

  assertEquals(registry.has("test-driver"), true);
  assertEquals(registry.has("TEST-DRIVER"), true);
  assertEquals(registry.has("unknown"), false);
});

Deno.test("DriverTypeRegistry - getAll returns all registered types", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "driver-a",
    name: "A",
    description: "a",
    isBuiltIn: true,
  });
  registry.register({
    type: "driver-b",
    name: "B",
    description: "b",
    isBuiltIn: false,
  });

  const all = registry.getAll();
  assertEquals(all.length, 2);
  assertEquals(all[0].type, "driver-a");
  assertEquals(all[1].type, "driver-b");
});

Deno.test("DriverTypeRegistry - register throws on duplicate", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "dup-driver",
    name: "Dup",
    description: "dup",
    isBuiltIn: true,
  });

  assertThrows(
    () =>
      registry.register({
        type: "dup-driver",
        name: "Dup Again",
        description: "dup again",
        isBuiltIn: true,
      }),
    Error,
    "already registered",
  );
});

Deno.test("DriverTypeRegistry - register user-defined type with createDriver", () => {
  const registry = new DriverTypeRegistry();
  const mockDriver = {
    type: "@myorg/custom",
    execute: () =>
      Promise.resolve({
        status: "success" as const,
        outputs: [],
        logs: [],
        durationMs: 0,
      }),
  };

  registry.register({
    type: "@myorg/custom",
    name: "Custom Driver",
    description: "A custom driver",
    isBuiltIn: false,
    createDriver: () => mockDriver,
  });

  const info = registry.get("@myorg/custom");
  assertEquals(info?.type, "@myorg/custom");
  assertEquals(info?.isBuiltIn, false);
  assertEquals(typeof info?.createDriver, "function");
});
