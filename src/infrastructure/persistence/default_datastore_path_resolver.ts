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

import { join } from "@std/path";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import {
  type DatastoreConfig,
  getDatastoreDirectories,
  isAlwaysLocal,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import {
  compilePatterns,
  isExcludedCompiled,
} from "../../domain/datastore/datastore_pattern_matcher.ts";
import { SWAMP_DATA_DIR } from "./paths.ts";

/**
 * Default implementation of DatastorePathResolver.
 *
 * Routes paths to either the local `.swamp/` directory or the configured
 * datastore based on the directory list and exclude patterns.
 */
export class DefaultDatastorePathResolver implements DatastorePathResolver {
  private readonly repoDir: string;
  private readonly datastoreConfig: DatastoreConfig;
  private readonly datastoreSubdirs: ReadonlySet<string>;
  private readonly compiledExclude: ReturnType<typeof compilePatterns>;
  private readonly datastoreBasePath: string;

  constructor(repoDir: string, datastoreConfig: DatastoreConfig) {
    this.repoDir = repoDir;
    this.datastoreConfig = datastoreConfig;
    this.datastoreSubdirs = new Set(getDatastoreDirectories(datastoreConfig));
    this.compiledExclude = compilePatterns(datastoreConfig.exclude ?? []);

    // Determine the base path for the datastore
    if (isCustomDatastoreConfig(datastoreConfig)) {
      // Custom: path was eagerly resolved during config resolution
      this.datastoreBasePath = datastoreConfig.datastorePath;
    } else if (datastoreConfig.type === "filesystem") {
      this.datastoreBasePath = datastoreConfig.path;
    } else {
      // S3: use local cache path
      this.datastoreBasePath = datastoreConfig.cachePath;
    }
  }

  localPath(...segments: string[]): string {
    return join(this.repoDir, SWAMP_DATA_DIR, ...segments);
  }

  datastorePath(...segments: string[]): string {
    return join(this.datastoreBasePath, ...segments);
  }

  isDatastoreSubdir(subdir: string): boolean {
    if (isAlwaysLocal(subdir)) {
      return false;
    }
    return this.datastoreSubdirs.has(subdir);
  }

  isExcluded(relativePath: string): boolean {
    if (this.compiledExclude.length === 0) {
      return false;
    }
    return isExcludedCompiled(relativePath, this.compiledExclude);
  }

  resolvePath(subdir: string, ...rest: string[]): string {
    // Always-local subdirs never go to datastore
    if (!this.isDatastoreSubdir(subdir)) {
      return this.localPath(subdir, ...rest);
    }

    // Check exclude patterns
    const relativePath = rest.length > 0 ? join(subdir, ...rest) : subdir;

    if (this.isExcluded(relativePath)) {
      return this.localPath(subdir, ...rest);
    }

    return this.datastorePath(subdir, ...rest);
  }

  config(): DatastoreConfig {
    return this.datastoreConfig;
  }
}
