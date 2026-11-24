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

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { modelRegistry } from "../domain/models/model.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { mergeExtensionMembers } from "./extension_merge.ts";
import type { LoadedExtension } from "./bundle_cache.ts";
import "../domain/models/models.ts";

function method(description: string) {
  return {
    description,
    arguments: z.object({}),
    execute: () => Promise.resolve({ dataHandles: [] }),
  };
}

const spec = {
  schema: z.object({}),
  lifetime: "infinite" as const,
  garbageCollection: 1,
};

function base(): ModelDefinition {
  return {
    type: ModelType.create("@acme/widget"),
    version: "2026.01.01.1",
    methods: { create: method("base create") },
    resources: { state: spec },
  } as unknown as ModelDefinition;
}

function addOn(
  methods: Record<string, unknown>,
  resources?: Record<string, unknown>,
): LoadedExtension {
  return { type: "@acme/widget", methods: [methods], resources };
}

Deno.test("mergeExtensionMembers: adds exactly the listed members and leaves unlisted ones out", () => {
  const merged = mergeExtensionMembers(base(), "@acme/widget", [{
    bundle: { fingerprint: "fp-a", methods: ["extra"], resources: ["audit"] },
    extension: addOn(
      { extra: method("add-on extra"), lost: method("lost to another") },
      { audit: spec, lostSpec: spec },
    ),
  }]);
  assertEquals(Object.keys(merged.methods).sort(), ["create", "extra"]);
  assertEquals(merged.methods.extra.description, "add-on extra");
  assertEquals(Object.keys(merged.resources ?? {}).sort(), ["audit", "state"]);
});

Deno.test("mergeExtensionMembers: flattens an add-on's methods array", () => {
  const merged = mergeExtensionMembers(base(), "@acme/widget", [{
    bundle: { fingerprint: "fp-a", methods: ["one", "two"], resources: [] },
    extension: {
      type: "@acme/widget",
      methods: [{ one: method("one") }, { two: method("two") }],
    },
  }]);
  assertEquals(Object.keys(merged.methods).sort(), ["create", "one", "two"]);
});

Deno.test("mergeExtensionMembers: never changes the base definition or the worker's registry entry", () => {
  const builtin = modelRegistry.get("command/shell")!;
  const before = Object.keys(builtin.methods).sort();
  const merged = mergeExtensionMembers(builtin, "command/shell", [{
    bundle: { fingerprint: "fp-a", methods: ["hello"], resources: [] },
    extension: { type: "command/shell", methods: [{ hello: method("hi") }] },
  }]);
  assertEquals(merged.methods.hello.description, "hi");
  assertEquals(Object.keys(builtin.methods).sort(), before);
  assertEquals(
    Object.keys(modelRegistry.get("command/shell")!.methods).sort(),
    before,
  );
});

Deno.test("mergeExtensionMembers: no add-ons returns the definition as loaded", () => {
  const def = base();
  assertEquals(mergeExtensionMembers(def, "@acme/widget", []) === def, true);
});

Deno.test("mergeExtensionMembers: a listed member the bundle lacks fails naming it", () => {
  assertThrows(
    () =>
      mergeExtensionMembers(base(), "@acme/widget", [{
        bundle: { fingerprint: "fp-a", methods: ["gone"], resources: [] },
        extension: addOn({ extra: method("extra") }),
      }]),
    Error,
    "has no method 'gone'",
  );
  assertThrows(
    () =>
      mergeExtensionMembers(base(), "@acme/widget", [{
        bundle: { fingerprint: "fp-a", methods: [], resources: ["gone"] },
        extension: addOn({}),
      }]),
    Error,
    "has no resource spec 'gone'",
  );
});

Deno.test("mergeExtensionMembers: an add-on for another type is refused", () => {
  assertThrows(
    () =>
      mergeExtensionMembers(base(), "@acme/widget", [{
        bundle: { fingerprint: "fp-a", methods: ["extra"], resources: [] },
        extension: {
          type: "@acme/other",
          methods: [{ extra: method("extra") }],
        },
      }]),
    Error,
    "not '@acme/widget'",
  );
});
