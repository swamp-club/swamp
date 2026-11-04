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

import { isAbsolute, resolve } from "@std/path";
import {
  type DatastoreConfigData,
  durableField,
  type FilesystemDatastoreConfig,
  readDatastoreFormatKey,
} from "../../domain/datastore/datastore_config.ts";
import { expandEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { resolveDatastoreExpressions } from "./resolve_expressions.ts";
/** Normalize an explicit filesystem block before opening or routing its data. */
export async function resolveFilesystemDatastoreConfig(
  config: DatastoreConfigData,
  repoDir: string,
  options: {
    /** Admit the normalized location before expressions can execute installed vault code. */
    beforeExpressions?: (base: FilesystemDatastoreConfig) => Promise<void>;
  } = {},
): Promise<FilesystemDatastoreConfig> {
  const format = readDatastoreFormatKey("filesystem", config.format);
  if (!config.path) {
    throw new Error(
      "Filesystem datastore config in .swamp.yaml requires a 'path' field.",
    );
  }
  const expanded = expandEnvVars(config.path);
  const base: FilesystemDatastoreConfig = {
    type: "filesystem",
    path: isAbsolute(expanded) ? expanded : resolve(repoDir, expanded),
    ...durableField(config),
    ...(format !== undefined ? { format } : {}),
  };
  await options.beforeExpressions?.(base);
  const fields = await resolveDatastoreExpressions({
    ...(config.namespace != null ? { namespace: config.namespace } : {}),
    ...(config.directories != null ? { directories: config.directories } : {}),
    ...(config.exclude != null ? { exclude: config.exclude } : {}),
    ...(config.hydrationStrategy != null
      ? { hydrationStrategy: config.hydrationStrategy }
      : {}),
  }, { repoDir });
  return {
    ...base,
    directories: fields.directories as string[] | undefined ??
      config.directories,
    exclude: fields.exclude as string[] | undefined ?? config.exclude,
    namespace: fields.namespace as string | undefined ?? config.namespace,
  };
}
