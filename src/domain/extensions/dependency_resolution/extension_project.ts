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
import { dirname, globToRegExp, join, resolve, SEPARATOR } from "@std/path";
import { DENO_CONFIG_FILE_NAMES, readDenoConfig } from "../deno_config.ts";
import { scanImportSites } from "./import_sites.ts";
import { isBareSpecifier } from "./specifier.ts";

const logger = getLogger(["swamp", "extensions", "project"]);

export interface ExtensionProject {
  denoConfigPath?: string;
  packageJsonDir?: string;
  workspaceRootConfigPath?: string;
  /**
   * --no-config is set when the extension has no Deno config inside the
   * boundary, so no config Deno would discover above it applies
   */
  noConfig?: boolean;
  ancestorConfigs?: AncestorConfig[];
}

export interface AncestorConfig {
  path: string;
  kind: "deno-config" | "package-json" | "workspace-root";
}

export type ExtensionProjectMode = "deno-config" | "package-json" | "none";

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
 * a manifest inside the repo walks to the repo dir so a monorepo root config
 * still applies; one outside walks only to its extensions root, else its own
 * directory
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

export interface ConfigWalkBoundary {
  dir?: string;
  /**
   * push, quality and fmt search dir itself; the loader stops below the
   * repository
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

/** an inclusive walk counts only files; the loader's walk counts any entry */
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

export function findDenoConfig(
  startDir: string,
  boundary: ConfigWalkBoundary,
): string | undefined {
  return findUpward(startDir, DENO_CONFIG_FILE_NAMES, boundary);
}

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

export function findLoaderDenoConfig(
  absolutePath: string,
  repoDir: string | null | undefined,
): string | undefined {
  return findDenoConfig(dirname(absolutePath), {
    ...(repoDir ? { dir: repoDir } : {}),
    inclusive: false,
  });
}

export function hasBareImport(source: string, path?: string): boolean {
  return (scanImportSites(source, path) ?? []).some((site) =>
    isBareSpecifier(site.specifier)
  );
}

export interface DetectExtensionProjectInput {
  manifestDir: string;
  extensionsRoot: string;
  repoDir: string;
  entryPoints: readonly string[];
  skip?: ReadonlySet<string>;
}

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
    const root = await findWorkspaceRoot(denoConfigPath);
    if (!root) return { denoConfigPath };
    if (isSameOrUnder(dirname(root), boundary)) {
      logger.debug`Config ${denoConfigPath} is a member of workspace ${root}`;
      return { denoConfigPath, workspaceRootConfigPath: root };
    }
    return {
      denoConfigPath,
      ancestorConfigs: [{ path: root, kind: "workspace-root" }],
    };
  }
  const project = await packageJsonProject(input, boundary);
  const ancestorConfigs = findAncestorConfigs(boundary, !project);
  return {
    ...(project ? { packageJsonDir: project } : {}),
    noConfig: true,
    ...(ancestorConfigs.length > 0 ? { ancestorConfigs } : {}),
  };
}

async function packageJsonProject(
  input: DetectExtensionProjectInput,
  boundary: string,
): Promise<string | undefined> {
  const candidateDir = findPackageJsonDir(input.manifestDir, boundary);
  if (!candidateDir) return undefined;
  for (const entryPoint of input.entryPoints) {
    if (input.skip?.has(entryPoint)) continue;
    if (hasBareImport(await Deno.readTextFile(entryPoint), entryPoint)) {
      logger.debug`Found package.json project at ${candidateDir}`;
      return candidateDir;
    }
  }
  logger
    .debug`Ignoring package.json at ${candidateDir} (extension uses npm: prefixed imports)`;
  return undefined;
}

export function findAncestorConfigs(
  boundary: string,
  withPackageJson: boolean,
): AncestorConfig[] {
  const parent = dirname(resolve(boundary));
  if (parent === resolve(boundary)) return [];
  const found: AncestorConfig[] = [];
  const denoConfig = findDenoConfig(parent, { inclusive: true });
  if (denoConfig) found.push({ path: denoConfig, kind: "deno-config" });
  if (withPackageJson) {
    const packageJson = findUpward(parent, ["package.json"], {
      inclusive: true,
    });
    if (packageJson) found.push({ path: packageJson, kind: "package-json" });
  }
  return found;
}

function workspaceMembers(config: Record<string, unknown>): string[] {
  const field = config.workspace;
  const members = Array.isArray(field)
    ? field
    : field && typeof field === "object"
    ? (field as Record<string, unknown>).members
    : undefined;
  return Array.isArray(members)
    ? members.filter((m): m is string => typeof m === "string")
    : [];
}

export function workspaceListsMember(
  rootDir: string,
  pattern: string,
  memberDir: string,
): boolean {
  const target = resolve(memberDir);
  const listed = resolve(rootDir, pattern.replace(/[\\/]+$/, ""));
  if (!/[*?[{]/.test(pattern)) return listed === target;
  return globToRegExp(listed, { globstar: true }).test(target);
}

/**
 * Deno stops at the nearest config with a workspace field: if it does not list
 * the member it is ignored and no workspace further up applies
 */
export async function findWorkspaceRoot(
  denoConfigPath: string,
): Promise<string | undefined> {
  const memberDir = dirname(resolve(denoConfigPath));
  let current = dirname(memberDir);
  while (true) {
    const candidate = findDenoConfig(current, {
      dir: current,
      inclusive: true,
    });
    if (candidate) {
      const config = await readDenoConfig(candidate);
      if (config && config.workspace !== undefined) {
        return workspaceMembers(config).some((m) =>
            workspaceListsMember(current, m, memberDir)
          )
          ? candidate
          : undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * mirrors denoProjectArgs in bundle.ts: no config or package.json project means
 * --no-lock; a workspace member's lock is its root's
 */
export async function configuredLockPath(
  project: ExtensionProject,
): Promise<string | undefined> {
  const lockConfigPath = project.workspaceRootConfigPath ??
    project.denoConfigPath;
  if (lockConfigPath) {
    const config = await readDenoConfig(lockConfigPath);
    if (!config) {
      // A config that cannot be read or parsed fails the bundle too; assume
      // no lock rather than one that may not apply.
      logger
        .debug`Config ${lockConfigPath} could not be parsed; no lockfile read`;
      return undefined;
    }
    const setting = configLockSetting(lockConfigPath, config);
    if (setting === null) return undefined;
    return setting ?? join(dirname(lockConfigPath), "deno.lock");
  }
  if (project.packageJsonDir) return join(project.packageJsonDir, "deno.lock");
  return undefined;
}

function configLockSetting(
  configPath: string,
  config: Record<string, unknown>,
): string | null | undefined {
  const lock = config.lock;
  if (lock === false) return null;
  if (typeof lock === "string") return resolve(dirname(configPath), lock);
  if (
    lock && typeof lock === "object" &&
    typeof (lock as Record<string, unknown>).path === "string"
  ) {
    return resolve(dirname(configPath), (lock as Record<string, string>).path);
  }
  return undefined;
}

/** Deno ignores a workspace member's own lock in favour of the root's */
export async function ignoredMemberLockPath(
  project: ExtensionProject,
): Promise<string | undefined> {
  if (!project.denoConfigPath || !project.workspaceRootConfigPath) {
    return undefined;
  }
  const config = await readDenoConfig(project.denoConfigPath);
  const setting = config
    ? configLockSetting(project.denoConfigPath, config)
    : undefined;
  const beside = join(dirname(project.denoConfigPath), "deno.lock");
  const own = setting ?? (await isFile(beside) ? beside : undefined);
  return own && own !== await configuredLockPath(project) ? own : undefined;
}

/**
 * a config this reader cannot parse may set its own lock, so the deno.lock
 * beside it is used when present rather than bundling without the project's
 * lock
 */
export async function frozenLockPath(
  project: ExtensionProject,
): Promise<string | undefined> {
  let path = await configuredLockPath(project);
  const lockConfigPath = project.workspaceRootConfigPath ??
    project.denoConfigPath;
  if (
    !path && lockConfigPath && !(await readDenoConfig(lockConfigPath))
  ) {
    path = join(dirname(lockConfigPath), "deno.lock");
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
