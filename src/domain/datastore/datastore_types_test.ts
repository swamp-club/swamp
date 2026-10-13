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
import { DatastoreTypeRegistry } from "./datastore_type_registry.ts";
import { listDatastoreTypes } from "./datastore_types.ts";

const LAZY_DATASTORE_SOURCE = (type: string, name: string) => `
export const datastore = {
  type: "${type}",
  name: ${name},
  description: "Declared description",
  createProvider: () => ({}),
};
`;

function lazyDatastoreRegistry(
  entries: Array<{ type: string }>,
): DatastoreTypeRegistry {
  const registry = new DatastoreTypeRegistry();
  for (const { type } of entries) {
    registry.registerLazy({
      type,
      bundlePath: `/repo/.swamp/datastore-bundles/${type}.js`,
      sourcePath: `/repo/extensions/datastores/${type}.ts`,
      version: "",
    });
  }
  return registry;
}

Deno.test("listDatastoreTypes: lists a lazy type under its declared name and description without loading it", async () => {
  const registry = lazyDatastoreRegistry([{ type: "@test/lazy" }]);
  let typeLoads = 0;
  registry.setTypeLoader(() => {
    typeLoads++;
    return Promise.resolve();
  });

  const types = await listDatastoreTypes(
    registry,
    () => Promise.resolve(LAZY_DATASTORE_SOURCE("@test/lazy", `"Lazy Store"`)),
  );

  assertEquals(types, [{
    type: "@test/lazy",
    name: "Lazy Store",
    description: "Declared description",
    isBuiltIn: false,
  }]);
  assertEquals(typeLoads, 0);
  assertEquals(registry.isLazy("@test/lazy"), true);
});

Deno.test("listDatastoreTypes: an unreadable source keeps the type id and an empty description", async () => {
  const registry = lazyDatastoreRegistry([{ type: "@test/gone" }]);

  const types = await listDatastoreTypes(
    registry,
    () => Promise.reject(new Deno.errors.NotFound("gone")),
  );

  assertEquals(types.map((t) => [t.name, t.description]), [
    ["@test/gone", ""],
  ]);
});

Deno.test("listDatastoreTypes: a computed name keeps the type id", async () => {
  const registry = lazyDatastoreRegistry([{ type: "@test/computed" }]);

  const types = await listDatastoreTypes(
    registry,
    () => Promise.resolve(LAZY_DATASTORE_SOURCE("@test/computed", "label")),
  );

  assertEquals(types.map((t) => [t.name, t.description]), [
    ["@test/computed", "Declared description"],
  ]);
});

Deno.test("listDatastoreTypes: a loaded type is listed from the registry, not from source", async () => {
  const registry = new DatastoreTypeRegistry();
  registry.register({
    type: "@test/loaded",
    name: "Loaded Store",
    description: "From the registry",
    isBuiltIn: false,
  });

  const types = await listDatastoreTypes(
    registry,
    () => Promise.reject(new Error("source must not be read")),
  );

  assertEquals(types.map((t) => t.name), ["Loaded Store"]);
});
