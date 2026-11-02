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
import type { DatastoreEngine } from "../../domain/datastore/datastore_format.ts";
import { datastoreEngineOf } from "./datastore_format_guard.ts";
import { SWAMP_DATA_DIR } from "./paths.ts";

export class DefaultDatastorePathResolver implements DatastorePathResolver {
  private readonly repoDir: string;
  private readonly datastoreConfig: DatastoreConfig;
  private readonly datastoreSubdirs: ReadonlySet<string>;
  private readonly compiledExclude: ReturnType<typeof compilePatterns>;
  private readonly datastoreBasePath: string;
  private readonly namespace: string;
  private readonly datastoreEngine: DatastoreEngine;

  constructor(
    repoDir: string,
    datastoreConfig: DatastoreConfig,
    options: { readonly engine?: DatastoreEngine } = {},
  ) {
    this.repoDir = repoDir;
    this.datastoreConfig = datastoreConfig;
    this.datastoreSubdirs = new Set(getDatastoreDirectories(datastoreConfig));
    this.compiledExclude = compilePatterns(datastoreConfig.exclude ?? []);
    this.namespace = datastoreConfig.namespace ?? "";
    this.datastoreEngine = options.engine ?? datastoreEngineOf(datastoreConfig);

    if (this.datastoreEngine === "v3") {
      // a v3 datastore path holds the commit log, not records; each checkout
      // materialises its records in its own .swamp/, so the datastore tier
      // resolves there
      this.datastoreBasePath = join(repoDir, SWAMP_DATA_DIR);
    } else if (isCustomDatastoreConfig(datastoreConfig)) {
      // use the local cache path so reads and writes hit the directory the sync
      // service pushes from and pulls to; custom datastores without a cache use
      // datastorePath
      this.datastoreBasePath = datastoreConfig.cachePath ??
        datastoreConfig.datastorePath;
    } else {
      this.datastoreBasePath = datastoreConfig.path;
    }
  }

  localPath(...segments: string[]): string {
    return join(this.repoDir, SWAMP_DATA_DIR, ...segments);
  }

  datastorePath(...segments: string[]): string {
    // the namespace is the outermost segment ({base}/{namespace}/data/...),
    // built with join so an empty namespace adds no stray separator
    if (this.namespace.length > 0) {
      return join(this.datastoreBasePath, this.namespace, ...segments);
    }
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
    // Glob patterns are authored with forward slashes; normalize the host
    // separator so Windows paths match POSIX-style patterns like `foo/**`.
    return isExcludedCompiled(
      relativePath.replaceAll("\\", "/"),
      this.compiledExclude,
    );
  }

  resolvePath(subdir: string, ...rest: string[]): string {
    if (!this.isDatastoreSubdir(subdir)) {
      return this.localPath(subdir, ...rest);
    }

    const relativePath = rest.length > 0 ? join(subdir, ...rest) : subdir;

    if (this.isExcluded(relativePath)) {
      return this.localPath(subdir, ...rest);
    }

    return this.datastorePath(subdir, ...rest);
  }

  config(): DatastoreConfig {
    return this.datastoreConfig;
  }

  engine(): DatastoreEngine {
    return this.datastoreEngine;
  }
}
