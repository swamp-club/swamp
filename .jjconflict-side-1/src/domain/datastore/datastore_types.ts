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
  {
    type: "s3",
    name: "Amazon S3",
    description:
      "Store data in an Amazon S3 bucket with local cache synchronization. Provides distributed access and collaboration.",
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
 * Gets all available datastore types.
 */
export function getDatastoreTypes(): DatastoreTypeInfo[] {
  return datastoreTypeRegistry.getAll();
}

/**
 * Gets a datastore type by its identifier.
 */
export function getDatastoreType(type: string): DatastoreTypeInfo | undefined {
  return datastoreTypeRegistry.get(type);
}
