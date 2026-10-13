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

import { assertEquals } from "@std/assert";
import {
  DatastoreTypeRegistry,
  type LazyDatastoreEntry,
} from "./datastore_type_registry.ts";
import { ensureAllDatastoreTypesLoaded } from "./datastore_types.ts";

function lazyDatastoreEntry(type: string): LazyDatastoreEntry {
  return {
    type,
    bundlePath: `/repo/.swamp/datastore-bundles/${type}.js`,
    sourcePath: `/repo/extensions/datastores/${type}.ts`,
    version: "2026.01.15.1",
  };
}

Deno.test("ensureAllDatastoreTypesLoaded: imports every lazy type so it is listed as declared", async () => {
  const registry = new DatastoreTypeRegistry();
  registry.registerLazy(lazyDatastoreEntry("@test/one"));
  registry.registerLazy(lazyDatastoreEntry("@test/two"));
  registry.setTypeLoader((type) => {
    registry.promoteFromLazy({
      type,
      name: `Declared ${type}`,
      description: `Description of ${type}`,
      isBuiltIn: false,
    });
    return Promise.resolve();
  });

  await ensureAllDatastoreTypesLoaded(registry);

  assertEquals(registry.getAllLazy(), []);
  assertEquals(
    registry.getAll().map((t) => [t.type, t.name, t.description]),
    [
      ["@test/one", "Declared @test/one", "Description of @test/one"],
      ["@test/two", "Declared @test/two", "Description of @test/two"],
    ],
  );
});

Deno.test("ensureAllDatastoreTypesLoaded: a type that fails to import keeps its placeholder and the rest still load", async () => {
  const registry = new DatastoreTypeRegistry();
  registry.registerLazy(lazyDatastoreEntry("@test/broken"));
  registry.registerLazy(lazyDatastoreEntry("@test/good"));
  registry.setTypeLoader((type) => {
    if (type === "@test/broken") {
      return Promise.reject(new Error("name: expected string"));
    }
    registry.promoteFromLazy({
      type,
      name: "Good Store",
      description: "A good store",
      isBuiltIn: false,
    });
    return Promise.resolve();
  });

  await ensureAllDatastoreTypesLoaded(registry);

  assertEquals(registry.getAllLazy().map((e) => e.type), ["@test/broken"]);
  assertEquals(registry.getAll().map((t) => t.name), ["Good Store"]);
});

Deno.test("ensureAllDatastoreTypesLoaded: a type the loader skips is dropped from the listing", async () => {
  const registry = new DatastoreTypeRegistry();
  registry.registerLazy(lazyDatastoreEntry("@test/skipped"));
  registry.setTypeLoader(() => Promise.resolve());

  await ensureAllDatastoreTypesLoaded(registry);

  assertEquals(registry.getAllLazy(), []);
  assertEquals(registry.getAll(), []);
});

Deno.test("ensureAllDatastoreTypesLoaded: runs the extension loader before importing lazy types", async () => {
  const registry = new DatastoreTypeRegistry();
  const calls: string[] = [];
  registry.setLoader(() => {
    calls.push("index");
    registry.registerLazy(lazyDatastoreEntry("@test/indexed"));
    return Promise.resolve();
  });
  registry.setTypeLoader((type) => {
    calls.push(type);
    return Promise.resolve();
  });

  await ensureAllDatastoreTypesLoaded(registry);

  assertEquals(calls, ["index", "@test/indexed"]);
});
