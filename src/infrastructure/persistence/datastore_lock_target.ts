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

import { checkedDatastoreEngine } from "./datastore_format_guard.ts";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  type FilesystemDatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";

let lockConfigs = new WeakMap<
  DatastoreConfig,
  FilesystemDatastoreConfig
>();

export function setV3BucketLockRoot(
  config: CustomDatastoreConfig | DatastoreConfig,
  root: string,
): void {
  lockConfigs.set(config, {
    type: "filesystem",
    path: root,
    ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
    ...(config.directories !== undefined
      ? { directories: config.directories }
      : {}),
    ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
    format: 3,
  });
}

/**
 * throws for a v3 extension config no binding has seen, since its locks would
 * be taken as v2 lock objects in its bucket; bind first via v3DatastoreConfigOf
 */
export function lockingConfigOf(config: DatastoreConfig): DatastoreConfig {
  const bound = lockConfigs.get(config);
  if (bound !== undefined) return bound;
  if (!isCustomDatastoreConfig(config)) return config;
  // An override names no format: the guard may have opened it as v3 from
  // its marker.
  if (config.format === 3 || checkedDatastoreEngine(config) === "v3") {
    throw new Error(
      `Internal error: a lock was asked of the v3 datastore ${config.type} ` +
        "before it was bound; open it through v3DatastoreConfigOf first",
    );
  }
  return config;
}

export function resetV3BucketLockRootsForTesting(): void {
  lockConfigs = new WeakMap();
}
