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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { CreekRegistry } from "./creek_registry.ts";
import { type CreekDefinition, defineCreekMethod } from "./creek.ts";

function fixture(type: string): CreekDefinition {
  return {
    type,
    version: "2026.06.01.1",
    methods: {
      ping: defineCreekMethod({
        description: "Returns pong",
        arguments: z.object({}),
        execute: () => Promise.resolve("pong"),
      }),
    },
  };
}

Deno.test("CreekRegistry.register: stores definition keyed by lowercased type", () => {
  const registry = new CreekRegistry();
  registry.register(fixture("@Me/Test"));

  assertEquals(registry.get("@me/test")?.type, "@Me/Test");
  assertEquals(registry.get("@ME/TEST")?.type, "@Me/Test");
});

Deno.test("CreekRegistry.register: throws on duplicate", () => {
  const registry = new CreekRegistry();
  registry.register(fixture("@me/test"));

  assertThrows(
    () => registry.register(fixture("@me/test")),
    Error,
    "already registered",
  );
});

Deno.test("CreekRegistry.has: true for both loaded and lazy", () => {
  const registry = new CreekRegistry();
  registry.register(fixture("@me/loaded"));
  registry.registerLazy({
    type: "@me/lazy",
    bundlePath: "/x/bundle.js",
    sourcePath: "/x/src.ts",
    version: "2026.06.01.1",
  });

  assert(registry.has("@me/loaded"));
  assert(registry.has("@me/lazy"));
  assert(!registry.has("@me/nope"));
});

Deno.test("CreekRegistry.registerLazy: skipped if already loaded", () => {
  const registry = new CreekRegistry();
  registry.register(fixture("@me/test"));
  registry.registerLazy({
    type: "@me/test",
    bundlePath: "/x/bundle.js",
    sourcePath: "/x/src.ts",
    version: "2026.06.01.1",
  });

  assertEquals(registry.getAllLazy().length, 0);
  assert(!registry.isLazy("@me/test"));
});

Deno.test("CreekRegistry.promoteFromLazy: moves entry from lazy to loaded", () => {
  const registry = new CreekRegistry();
  registry.registerLazy({
    type: "@me/test",
    bundlePath: "/x/bundle.js",
    sourcePath: "/x/src.ts",
    version: "2026.06.01.1",
  });
  assert(registry.isLazy("@me/test"));

  registry.promoteFromLazy(fixture("@me/test"));

  assert(!registry.isLazy("@me/test"));
  assertEquals(registry.get("@me/test")?.type, "@me/test");
});

Deno.test("CreekRegistry.ensureTypeLoaded: dedupes concurrent loads", async () => {
  const registry = new CreekRegistry();
  registry.registerLazy({
    type: "@me/test",
    bundlePath: "/x/bundle.js",
    sourcePath: "/x/src.ts",
    version: "2026.06.01.1",
  });

  let loaderCalls = 0;
  registry.setTypeLoader(async (type) => {
    loaderCalls++;
    await new Promise((r) => setTimeout(r, 5));
    registry.promoteFromLazy(fixture(type));
  });

  await Promise.all([
    registry.ensureTypeLoaded("@me/test"),
    registry.ensureTypeLoaded("@me/test"),
    registry.ensureTypeLoaded("@me/test"),
  ]);

  assertEquals(loaderCalls, 1);
  assertEquals(registry.get("@me/test")?.type, "@me/test");
});

Deno.test("CreekRegistry.types: returns lowercased keys for both loaded and lazy", () => {
  const registry = new CreekRegistry();
  registry.register(fixture("@Me/A"));
  registry.registerLazy({
    type: "@Me/B",
    bundlePath: "/x.js",
    sourcePath: "/x.ts",
    version: "2026.06.01.1",
  });

  const types = registry.types().sort();
  assertEquals(types, ["@me/a", "@me/b"]);
});
