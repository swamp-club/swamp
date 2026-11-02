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

import type { DatastoreConfig } from "./datastore_config.ts";
import type { DatastoreEngine } from "./datastore_format.ts";

export interface DatastorePathResolver {
  localPath(...segments: string[]): string;

  datastorePath(...segments: string[]): string;

  isDatastoreSubdir(subdir: string): boolean;

  isExcluded(relativePath: string): boolean;

  resolvePath(subdir: string, ...rest: string[]): string;

  config(): DatastoreConfig;

  /** absent on a resolver that predates it, which means v2; use resolverEngine */
  engine?(): DatastoreEngine;
}

export function resolverEngine(
  resolver: DatastorePathResolver | undefined,
): DatastoreEngine {
  return resolver?.engine?.() ?? "v2";
}
