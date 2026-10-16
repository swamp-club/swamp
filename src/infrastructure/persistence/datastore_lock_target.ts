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

/**
 * Where a datastore's global and per-model locks are taken
 * (swamp-club#3534). A v2 extension datastore takes them in its bucket
 * through its provider. A v3 datastore on a bucket takes them as a
 * filesystem v3 datastore does, as file locks: its writer lease already
 * admits one writing process at a time across every machine, so its locks
 * only order the work inside that process and its checkout. They live
 * under its local root (`.swamp/_datastore_v3_copies/<key>/`), which the v3
 * binding registers here when it binds the datastore.
 *
 * @module
 */

import { checkedDatastoreEngine } from "./datastore_format_guard.ts";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  type FilesystemDatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";

/** The filesystem-shaped config each bound v3 bucket config locks under. */
let lockConfigs = new WeakMap<
  CustomDatastoreConfig,
  FilesystemDatastoreConfig
>();

/**
 * Records that the v3 bucket datastore `config` names takes its locks
 * under the local directory `root`. Called by the v3 binding.
 */
export function setV3BucketLockRoot(
  config: CustomDatastoreConfig,
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
 * The config a datastore's locks are taken on: a bound v3 bucket
 * datastore's local root, as a filesystem config; any other config as it
 * is. A lock site that takes the provider's lock for an extension config
 * and a file lock otherwise passes its config through this first.
 *
 * @throws Error for a v3 extension config no binding has seen: its locks
 *   would otherwise be taken as v2 lock objects in its bucket. Every
 *   writing context binds its config first (`v3DatastoreConfigOf`).
 */
export function lockingConfigOf(config: DatastoreConfig): DatastoreConfig {
  if (!isCustomDatastoreConfig(config)) return config;
  const bound = lockConfigs.get(config);
  if (bound !== undefined) return bound;
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

/** Test seam: forgets every bucket datastore's lock root. */
export function resetV3BucketLockRootsForTesting(): void {
  lockConfigs = new WeakMap();
}
