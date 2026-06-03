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
 * Interface for resolving paths to local or datastore tier.
 *
 * The path resolver determines whether a given subdirectory/file belongs
 * to the local `.swamp/` directory or to the configured datastore, based
 * on the datastore configuration, directory list, and exclude patterns.
 */

import type { DatastoreConfig } from "./datastore_config.ts";

/**
 * Resolves paths to either local `.swamp/` or the configured datastore.
 */
export interface DatastorePathResolver {
  /**
   * Returns a path within the local `.swamp/` directory.
   * Always uses `{repoDir}/.swamp/...` regardless of datastore config.
   */
  localPath(...segments: string[]): string;

  /**
   * Returns a path within the datastore directory.
   * For filesystem datastores: `{config.path}/...`
   * For S3 datastores: `{config.cachePath}/...`
   */
  datastorePath(...segments: string[]): string;

  /**
   * Checks if a subdirectory belongs to the datastore tier.
   * Returns true if the subdir is in the configured directories list
   * and is not an always-local subdir.
   */
  isDatastoreSubdir(subdir: string): boolean;

  /**
   * Checks if a relative path is excluded from the datastore
   * by gitignore-style exclude patterns.
   */
  isExcluded(relativePath: string): boolean;

  /**
   * Routes a path to either local or datastore based on config + patterns.
   *
   * A file goes to the datastore if:
   * 1. Its parent subdirectory is in the `directories` list, AND
   * 2. It does not match any `exclude` pattern
   *
   * Otherwise it stays in local `.swamp/`.
   */
  resolvePath(subdir: string, ...rest: string[]): string;

  /**
   * Returns the current datastore configuration.
   */
  config(): DatastoreConfig;
}
