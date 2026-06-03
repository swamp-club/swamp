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

import {
  type DatastoreTypeInfo,
  datastoreTypeRegistry,
} from "./datastore_type_registry.ts";

export type { DatastoreTypeInfo } from "./datastore_type_registry.ts";

/**
 * Built-in datastore type definitions.
 */
const BUILT_IN_DATASTORE_TYPES: DatastoreTypeInfo[] = [
  {
    type: "filesystem",
    name: "Filesystem",
    description:
      "Store data directly on the local filesystem. This is the default datastore with no remote synchronization.",
    isBuiltIn: true,
  },
];

// Register built-in types on module load
for (const datastoreType of BUILT_IN_DATASTORE_TYPES) {
  if (!datastoreTypeRegistry.has(datastoreType.type)) {
    datastoreTypeRegistry.register(datastoreType);
  }
}

/**
 * Gets all available datastore types (both loaded and lazy).
 * Lazy types are synthesized from catalog metadata.
 */
export function getDatastoreTypes(): DatastoreTypeInfo[] {
  const loaded = datastoreTypeRegistry.getAll();
  const loadedKeys = new Set(loaded.map((t) => t.type.toLowerCase()));

  const lazy = datastoreTypeRegistry.getAllLazy()
    .filter((entry) => !loadedKeys.has(entry.type.toLowerCase()))
    .map((entry) => ({
      type: entry.type,
      name: entry.type,
      description: "",
      isBuiltIn: false,
    }));

  return [...loaded, ...lazy];
}

/**
 * Gets a datastore type by its identifier.
 */
export function getDatastoreType(type: string): DatastoreTypeInfo | undefined {
  return datastoreTypeRegistry.get(type);
}
