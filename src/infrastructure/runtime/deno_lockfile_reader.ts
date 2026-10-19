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
import type {
  DependencyRegistry,
  LockedDependencyVersions,
} from "../../domain/extensions/dependency_version_resolution.ts";

const logger = getLogger(["swamp", "extensions", "lockfile"]);

/** A larger lockfile is not read; the audit resolves from the registry. */
export const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;

const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set(["4", "5"]);

/** Where the bundler finds the extension's dependencies. */
export interface ExtensionProject {
  denoConfigPath?: string;
  packageJsonDir?: string;
}

/**
 * The lockfile the bundler honours for this project, following
 * `denoProjectArgs` in src/domain/models/bundle.ts: with a deno.json, its
 * `lock` setting or else the deno.lock beside it; in package.json mode, the
 * deno.lock in that directory; otherwise none, since the bundler runs with
 * `--no-lock`.
 */
export async function lockfilePathFor(
  project: ExtensionProject,
): Promise<string | undefined> {
  if (project.denoConfigPath) {
    const configDir = dirname(project.denoConfigPath);
    let lock: unknown;
    try {
      lock = JSON.parse(await Deno.readTextFile(project.denoConfigPath)).lock;
    } catch {
      // An unreadable config leaves Deno's default.
    }
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

/** `npm:@scope/name@range` or `jsr:@scope/name@range` → its package. */
function packageOfSpecifier(
  key: string,
): { registry: DependencyRegistry; name: string } | null {
  const match = /^(npm|jsr):((?:@[^/@]+\/)?[^/@]+)/.exec(key);
  return match
    ? { registry: match[1] as DependencyRegistry, name: match[2] }
    : null;
}

/** `name@version` or `name@version_peer…` → its name and bare version. */
function packageOfEntry(key: string): { name: string; version: string } | null {
  const at = key.indexOf("@", 1);
  if (at <= 0) return null;
  return {
    name: key.slice(0, at),
    version: key.slice(at + 1).split("_")[0],
  };
}

/**
 * The versions a Deno lockfile (format 4 or 5) records, read as data: the
 * resolved value of each top-level specifier and every key of the `npm` and
 * `jsr` sections. Undefined when the file is missing, too large, not JSON
 * or another format, so the audit resolves from the registry instead.
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

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return undefined;
    body = parsed as Record<string, unknown>;
  } catch {
    logger.debug`Lockfile ${path} is not JSON; not read`;
    return undefined;
  }
  if (!SUPPORTED_VERSIONS.has(String(body.version))) {
    logger.debug`Lockfile ${path} has format ${body.version}; not read`;
    return undefined;
  }

  const versions = new Map<string, Set<string>>();
  const record = (registry: DependencyRegistry, name: string, v: string) => {
    const key = `${registry}:${name}`;
    const set = versions.get(key) ?? new Set<string>();
    set.add(v);
    versions.set(key, set);
  };

  const specifiers = body.specifiers;
  if (specifiers && typeof specifiers === "object") {
    for (const [key, value] of Object.entries(specifiers)) {
      const pkg = packageOfSpecifier(key);
      if (pkg && typeof value === "string") {
        record(pkg.registry, pkg.name, value.split("_")[0]);
      }
    }
  }
  for (const registry of ["npm", "jsr"] as const) {
    const section = body[registry];
    if (!section || typeof section !== "object") continue;
    for (const key of Object.keys(section)) {
      const entry = packageOfEntry(key);
      if (entry) record(registry, entry.name, entry.version);
    }
  }

  return {
    source: basename(path),
    versionsFor: (registry, name) => [
      ...(versions.get(`${registry}:${name}`) ?? []),
    ],
  };
}

/** The lockfile the bundler honours for `project`, read; or undefined. */
export async function readProjectLockfile(
  project: ExtensionProject,
): Promise<LockedDependencyVersions | undefined> {
  const path = await lockfilePathFor(project);
  return path ? await readDenoLockfile(path) : undefined;
}
