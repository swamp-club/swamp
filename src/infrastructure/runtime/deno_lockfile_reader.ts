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

import { getLogger } from "@logtape/logtape";
import { basename } from "@std/path";
import {
  type LockedDependencyVersions,
  MAX_LOCKFILE_BYTES,
  parseDenoLockfile,
} from "@swamp-club/extension-scoring/dependency-audit";
import type { ReadOnlyLock } from "../../domain/models/bundle.ts";
import {
  configuredLockPath,
  type ExtensionProject,
  frozenLockPath,
} from "../../domain/extensions/dependency_resolution/extension_project.ts";

const logger = getLogger(["swamp", "extensions", "lockfile"]);

export type { ExtensionProject };

/**
 * The Deno lockfile at `path` (format 4 or 5), read as data with
 * `parseDenoLockfile`. Undefined when the file is missing, too large, not
 * JSON or another format, so the audit resolves from the registry instead.
 */
export async function readDenoLockfile(
  path: string,
): Promise<LockedDependencyVersions | undefined> {
  let text: string;
  try {
    const info = await Deno.stat(path);
    if (info.size > MAX_LOCKFILE_BYTES) {
      logger
        .debug`Lockfile ${path} is over ${MAX_LOCKFILE_BYTES} bytes; not read`;
      return undefined;
    }
    text = await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
  const lock = parseDenoLockfile(text, basename(path));
  if (!lock) {
    logger.debug`Lockfile ${path} is not a format 4 or 5 lockfile; not read`;
  }
  return lock;
}

/** The lockfile the bundler honours for `project`, read; or undefined. */
export async function readProjectLockfile(
  project: ExtensionProject,
): Promise<LockedDependencyVersions | undefined> {
  const path = await configuredLockPath(project);
  return path ? await readDenoLockfile(path) : undefined;
}

/**
 * The lockfile push leaves untouched for `project`, as the bundle options
 * name it: see {@link frozenLockPath}.
 */
export async function readOnlyLockFor(
  project: ExtensionProject,
): Promise<ReadOnlyLock> {
  const lockPath = await frozenLockPath(project);
  return lockPath ? { lockPath } : {};
}
