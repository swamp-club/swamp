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
import { basename, dirname, join, resolve } from "@std/path";
import {
  type LockedDependencyVersions,
  MAX_LOCKFILE_BYTES,
  parseDenoLockfile,
} from "@swamp-club/extension-scoring/dependency-audit";
import type { ReadOnlyLock } from "../../domain/models/bundle.ts";
import { readDenoConfig } from "../../domain/extensions/deno_config.ts";

const logger = getLogger(["swamp", "extensions", "lockfile"]);

/** Where the bundler finds the extension's dependencies. */
export interface ExtensionProject {
  denoConfigPath?: string;
  packageJsonDir?: string;
}

/**
 * The lockfile the bundler honours for this project, following
 * `denoProjectArgs` in src/domain/models/bundle.ts: with a deno.json or
 * deno.jsonc (read as JSONC, as Deno reads it), its
 * `lock` setting or else the deno.lock beside it; in package.json mode, the
 * deno.lock in that directory; otherwise none, since the bundler runs with
 * `--no-lock`.
 */
export async function lockfilePathFor(
  project: ExtensionProject,
): Promise<string | undefined> {
  if (project.denoConfigPath) {
    const configDir = dirname(project.denoConfigPath);
    const config = await readDenoConfig(project.denoConfigPath);
    if (!config) {
      // A config that cannot be read or parsed fails the bundle too; assume
      // no lock rather than one that may not apply.
      logger
        .debug`Config ${project.denoConfigPath} could not be parsed; no lockfile read`;
      return undefined;
    }
    const lock = config.lock;
    if (lock === false) return undefined;
    if (typeof lock === "string") return resolve(configDir, lock);
    if (
      lock && typeof lock === "object" &&
      typeof (lock as Record<string, unknown>).path === "string"
    ) {
      return resolve(configDir, (lock as Record<string, string>).path);
    }
    return join(configDir, "deno.lock");
  }
  if (project.packageJsonDir) return join(project.packageJsonDir, "deno.lock");
  return undefined;
}

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
  const path = await lockfilePathFor(project);
  return path ? await readDenoLockfile(path) : undefined;
}

/**
 * The lockfile push leaves untouched for `project`: the lock the bundler
 * honours when it exists on disk, so the bundle runs `--frozen`; otherwise
 * none, so it runs `--no-lock` and creates no lock. A config this reader
 * cannot parse may set its own lock, which it cannot see, so the
 * `deno.lock` beside it is used when present rather than bundling without
 * the lock the project has.
 */
export async function readOnlyLockFor(
  project: ExtensionProject,
): Promise<ReadOnlyLock> {
  let path = await lockfilePathFor(project);
  if (
    !path && project.denoConfigPath &&
    !(await readDenoConfig(project.denoConfigPath))
  ) {
    path = join(dirname(project.denoConfigPath), "deno.lock");
  }
  return path && await isFile(path) ? { lockPath: path } : {};
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}
