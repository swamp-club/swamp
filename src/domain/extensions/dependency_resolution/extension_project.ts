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
 * The project an extension is bundled under: its Deno config, or the
 * package.json project its bare imports resolve through, and the lockfile
 * the bundle runs against. The one place push, quality, fmt and the loader
 * look for them (swamp-club#3969).
 */

import { getLogger } from "@logtape/logtape";
import { dirname, join, resolve, SEPARATOR } from "@std/path";
import { DENO_CONFIG_FILE_NAMES, readDenoConfig } from "../deno_config.ts";
import { scanImportSites } from "./import_sites.ts";
import { isBareSpecifier } from "./specifier.ts";

const logger = getLogger(["swamp", "extensions", "project"]);

/**
 * Where the bundler finds an extension's dependencies: a Deno config
 * (deno.json or deno.jsonc), else a package.json project's directory, else
 * neither.
 */
export interface ExtensionProject {
  denoConfigPath?: string;
  packageJsonDir?: string;
}

/** How a project resolves its bare imports. */
export type ExtensionProjectMode = "deno-config" | "package-json" | "none";

/** A project's mode: a Deno config wins over a package.json. */
export function extensionProjectMode(
  project: ExtensionProject,
): ExtensionProjectMode {
  return project.denoConfigPath
    ? "deno-config"
    : project.packageJsonDir
    ? "package-json"
    : "none";
}

function isSameOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + SEPARATOR);
}

/**
 * Where the `deno.json` / `package.json` walk up from the manifest stops.
 * A manifest inside the repo walks to the repo dir, as it always has, so a
 * monorepo's root config still applies to an extension pushed with
 * `--extensions-dir` at a sub-directory. A manifest outside the repo walks
 * to the extensions root that contains it, never further; the manifest's
 * own directory when neither contains it.
 */
export function projectConfigBoundary(
  manifestDir: string,
  extensionsRoot: string,
  repoDir: string,
): string {
  const dir = resolve(manifestDir);
  const root = resolve(extensionsRoot);
  const repo = resolve(repoDir);
  if (isSameOrUnder(dir, repo)) return repo;
  if (isSameOrUnder(dir, root)) return root;
  return dir;
}

/** How far a config walk goes up from its start. */
export interface ConfigWalkBoundary {
  /** The directory the walk stops at; the filesystem root when absent. */
  dir?: string;
  /**
   * Whether `dir` itself is searched. Push, quality and fmt search it;
   * the loader stops below the repository, and below the filesystem root.
   */
  inclusive: boolean;
}

function existsSync(path: string, fileOnly: boolean): boolean {
  try {
    const info = Deno.statSync(path);
    return !fileOnly || info.isFile;
  } catch {
    return false;
  }
}

/**
 * The first of `fileNames` walking up from `startDir` within `boundary`,
 * the earlier name winning in one directory; undefined when none is found.
 * An inclusive walk counts only a file; the loader's walk counts any entry,
 * as it always has.
 */
function findUpward(
  startDir: string,
  fileNames: readonly string[],
  boundary: ConfigWalkBoundary,
): string | undefined {
  let current = resolve(startDir);
  const stop = boundary.dir === undefined ? undefined : resolve(boundary.dir);
  const fsRoot = resolve("/");
  while (true) {
    if (!boundary.inclusive && (current === stop || current === fsRoot)) {
      return undefined;
    }
    for (const fileName of fileNames) {
      const candidate = join(current, fileName);
      if (existsSync(candidate, boundary.inclusive)) return candidate;
    }
    if (boundary.inclusive && current === stop) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The project Deno config: the first `deno.json` or `deno.jsonc` walking up
 * from `startDir` within `boundary`, `deno.json` winning in one directory
 * as it does for Deno.
 */
export function findDenoConfig(
  startDir: string,
  boundary: ConfigWalkBoundary,
): string | undefined {
  return findUpward(startDir, DENO_CONFIG_FILE_NAMES, boundary);
}

/**
 * The directory of the first `package.json` walking up from `startDir` to
 * `boundaryDir` (inclusive), or undefined when there is none.
 */
export function findPackageJsonDir(
  startDir: string,
  boundaryDir: string,
): string | undefined {
  const path = findUpward(startDir, ["package.json"], {
    dir: boundaryDir,
    inclusive: true,
  });
  return path === undefined ? undefined : dirname(path);
}

/**
 * The config the loader bundles a source file under: the nearest
 * `deno.json` or `deno.jsonc` above it, stopping below `repoDir`.
 */
export function findLoaderDenoConfig(
  absolutePath: string,
  repoDir: string | null | undefined,
): string | undefined {
  return findDenoConfig(dirname(absolutePath), {
    ...(repoDir ? { dir: repoDir } : {}),
    inclusive: false,
  });
}

/**
 * Whether `source` imports a bare name in any import form: static,
 * side-effect, dynamic or re-export (see {@link scanImportSites}). A module
 * that does not parse imports none; the bundler reports its syntax error.
 * `path` picks TypeScript, JavaScript or JSX.
 */
export function hasBareImport(source: string, path?: string): boolean {
  return (scanImportSites(source, path) ?? []).some((site) =>
    isBareSpecifier(site.specifier)
  );
}

/** What {@link detectExtensionProject} reads of an extension. */
export interface DetectExtensionProjectInput {
  manifestDir: string;
  extensionsRoot: string;
  repoDir: string;
  /**
   * The entry points whose bare `from` imports make a package.json beside
   * the extension its project; read in order until one has one.
   */
  entryPoints: readonly string[];
  /** Entry points not to read (reached through a symlink). */
  skip?: ReadonlySet<string>;
}

/**
 * The project push, quality and fmt bundle an extension under: the Deno
 * config walking up from the manifest to {@link projectConfigBoundary};
 * without one, the package.json project walking the same way, when an
 * entry point imports a bare name with `from`; else neither.
 */
export async function detectExtensionProject(
  input: DetectExtensionProjectInput,
): Promise<ExtensionProject> {
  const boundary = projectConfigBoundary(
    input.manifestDir,
    input.extensionsRoot,
    input.repoDir,
  );
  const denoConfigPath = findDenoConfig(input.manifestDir, {
    dir: boundary,
    inclusive: true,
  });
  if (denoConfigPath) {
    logger.debug`Found Deno config at ${denoConfigPath}`;
    return { denoConfigPath };
  }
  const candidateDir = findPackageJsonDir(input.manifestDir, boundary);
  if (!candidateDir) return {};
  for (const entryPoint of input.entryPoints) {
    if (input.skip?.has(entryPoint)) continue;
    if (hasBareImport(await Deno.readTextFile(entryPoint), entryPoint)) {
      logger.debug`Found package.json project at ${candidateDir}`;
      return { packageJsonDir: candidateDir };
    }
  }
  logger
    .debug`Ignoring package.json at ${candidateDir} (extension uses npm: prefixed imports)`;
  return {};
}

/**
 * The lockfile the bundler honours for this project, following
 * `denoProjectArgs` in src/domain/models/bundle.ts: with a deno.json or
 * deno.jsonc (read as JSONC, as Deno reads it), its `lock` setting or else
 * the deno.lock beside it; in package.json mode, the deno.lock in that
 * directory; otherwise none, since the bundler runs with `--no-lock`. The
 * dependency audit reads this lock.
 */
export async function configuredLockPath(
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
 * The lockfile push bundles `--frozen` against and leaves untouched: the
 * lock the bundler honours when it exists on disk; otherwise none, so the
 * bundle runs `--no-lock` and creates no lock. A config this reader cannot
 * parse may set its own lock, which it cannot see, so the `deno.lock`
 * beside it is used when present rather than bundling without the lock the
 * project has.
 */
export async function frozenLockPath(
  project: ExtensionProject,
): Promise<string | undefined> {
  let path = await configuredLockPath(project);
  if (
    !path && project.denoConfigPath &&
    !(await readDenoConfig(project.denoConfigPath))
  ) {
    path = join(dirname(project.denoConfigPath), "deno.lock");
  }
  return path && await isFile(path) ? path : undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}
