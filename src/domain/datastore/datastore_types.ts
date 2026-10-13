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

import { extractDatastoreFromSource } from "../extensions/extension_content_extractor.ts";
import { readDeclaredTypeMetadata } from "../extensions/declared_type_metadata.ts";
import {
  type DatastoreTypeInfo,
  type DatastoreTypeRegistry,
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
 * Lists every datastore type the way it declares itself, for type search.
 *
 * A lazy entry carries no declared name, so {@link getDatastoreTypes} can only
 * show its type id (swamp-club#3365). This reads the name and description
 * out of the entry's source text instead of importing its bundle: a listing
 * must not run extension code, which can exit, hang or print at import. A
 * source that cannot be read, or that computes its name, keeps the type id.
 */
export async function listDatastoreTypes(
  registry: DatastoreTypeRegistry = datastoreTypeRegistry,
  readSource?: (path: string) => Promise<string>,
): Promise<DatastoreTypeInfo[]> {
  const loaded = registry.getAll();
  const loadedKeys = new Set(loaded.map((t) => t.type.toLowerCase()));

  const lazy = await Promise.all(
    registry.getAllLazy()
      .filter((entry) => !loadedKeys.has(entry.type.toLowerCase()))
      .map(async (entry) => {
        const declared = await readDeclaredTypeMetadata(
          entry,
          extractDatastoreFromSource,
          readSource,
        );
        return {
          type: entry.type,
          name: declared?.name || entry.type,
          description: declared?.description || "",
          isBuiltIn: false,
        };
      }),
  );

  return [...loaded, ...lazy];
}

/**
 * Gets a datastore type by its identifier.
 */
export function getDatastoreType(type: string): DatastoreTypeInfo | undefined {
  return datastoreTypeRegistry.get(type);
}
