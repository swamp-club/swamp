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

import {
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
  SEPARATOR_PATTERN,
  toFileUrl,
} from "@std/path";
import type { UnauditedDependency } from "@swamp-club/extension-scoring/dependency-audit";
import { stripAnsiCode } from "@std/fmt/colors";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  denoProjectArgs,
  isStaleLockfile,
  type ReadOnlyLock,
  staleLockfileError,
} from "../../domain/models/bundle.ts";
import { readOnlyLockFor } from "./deno_lockfile_reader.ts";
import { sha256Hex } from "../persistence/config_staging.ts";
import { runDenoInfo } from "../../domain/extensions/dependency_resolution/deno_info.ts";
import {
  bareImportsFromDenoInfo,
  denoInfoRootDir,
  hasUnresolvedBareImports,
  installedPackageDir,
  installedPackageImports,
  isLocalModuleSpecifier,
  type ResolvedBareImport,
  withPackageSpecifiers,
} from "../../domain/extensions/bare_import_resolution.ts";
import {
  installedPackageVersion,
  type PackageVersion,
  type PackageVersions,
  packageVersionsFromDenoInfo,
} from "../../domain/extensions/dependency_resolution/package_versions.ts";
import {
  nonRegistryDependencies,
  urlImportClosures,
} from "../../domain/extensions/dependency_resolution/unaudited_code.ts";
import { jsrDistTag } from "../../domain/extensions/dependency_resolution/specifier.ts";
import type {
  DistTaggedJsrImport,
  InstalledPackage,
  LocalEdge,
  LocalModule,
  MissingLocalModule,
  ModuleGraphProject,
  ModuleGraphReader,
  ModuleGraphReaderFactory,
  SourceModuleGraph,
  SpecifierSpan,
} from "../../domain/extensions/extension_source_graph.ts";

const CODE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "JavaScript",
  "Jsx",
  "Mjs",
  "Cjs",
  "TypeScript",
  "Mts",
  "Cts",
  "Dts",
  "Dmts",
  "Dcts",
  "Tsx",
]);

interface DenoInfoDependencyTarget {
  specifier?: string;
  span?: SpecifierSpan;
}

interface DenoInfoDependency {
  specifier?: string;
  code?: DenoInfoDependencyTarget;
  type?: DenoInfoDependencyTarget;
}

interface DenoInfoModule {
  specifier?: string;
  kind?: string;
  mediaType?: string | null;
  error?: string;
  dependencies?: DenoInfoDependency[];
}

/** Reads what the importer has at `span`, quotes stripped, or undefined. */
function textAt(
  lines: string[] | undefined,
  span: SpecifierSpan,
): string | undefined {
  if (!lines || span.start.line !== span.end.line) return undefined;
  const line = lines[span.start.line];
  if (line === undefined) return undefined;
  const quoted = Array.from(line).slice(
    span.start.character,
    span.end.character,
  )
    .join("");
  const quote = quoted[0];
  if (quoted.length < 2 || !["'", '"', "`"].includes(quote)) return undefined;
  if (quoted[quoted.length - 1] !== quote) return undefined;
  return quoted.slice(1, -1);
}

/** File access the parser needs: whether a module exists, and its text. */
export interface DenoInfoGraphFiles {
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string | undefined>;
}

/**
 * Reads the local part of `deno info --json` output, and what Deno resolved
 * each bare import a local module writes to. `files.exists` decides
 * whether a module deno did not load itself (a text or bytes import, which
 * deno reports as external) is on disk. Each edge's specifier is the text
 * the importer holds at the edge's span — for a type edge that may be a
 * `@ts-types` pragma or a `/// <reference>` rather than the import itself.
 */
export async function parseDenoInfoGraph(
  json: unknown,
  files: DenoInfoGraphFiles,
): Promise<SourceModuleGraph> {
  const raw = (json as { modules?: DenoInfoModule[] })?.modules;
  if (!Array.isArray(raw)) {
    throw new Error("deno info output has no modules list");
  }
  const modules: LocalModule[] = [];
  const edges: LocalEdge[] = [];
  const missingReasons = new Map<string, string>();
  // Paths are read from the entry point's directory, so a repository under
  // a directory named node_modules is not taken for an installed package.
  const rootDir = denoInfoRootDir(json);

  for (const m of raw) {
    if (!isLocalModuleSpecifier(m.specifier, rootDir)) continue;
    const path = fromFileUrl(m.specifier);
    if (m.error) {
      missingReasons.set(path, m.error);
      continue;
    }
    if (m.kind === "esm" && CODE_MEDIA_TYPES.has(m.mediaType ?? "")) {
      modules.push({ path, kind: "code" });
    } else if (m.kind === "external" && !await files.exists(path)) {
      missingReasons.set(path, `Module not found "${m.specifier}".`);
      continue;
    } else {
      modules.push({ path, kind: "data" });
    }
    let lines: string[] | undefined;
    let linesRead = false;
    for (const dep of m.dependencies ?? []) {
      for (const target of [dep.code, dep.type]) {
        if (
          !target || !isLocalModuleSpecifier(target.specifier, rootDir) ||
          !target.span
        ) continue;
        if (!linesRead) {
          lines = (await files.readText(path))?.split("\n");
          linesRead = true;
        }
        const specifier = textAt(lines, target.span) ?? dep.specifier;
        if (typeof specifier !== "string") continue;
        edges.push({
          importer: path,
          target: fromFileUrl(target.specifier),
          specifier,
          span: target.span,
        });
      }
    }
  }

  const missing: MissingLocalModule[] = [];
  for (const [path, reason] of missingReasons) {
    const importer = edges.find((e) => e.target === path)?.importer;
    missing.push(importer ? { path, importer, reason } : { path, reason });
  }
  // A module a code import and a type import both reach appears once.
  const seen = new Set<string>();
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.importer}\0${e.span.start.line}:${e.span.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    modules,
    edges: uniqueEdges,
    missing,
    bareImports: bareImportsFromDenoInfo(json),
  };
}

/**
 * The project's package.json. One that cannot be read or parsed fails the
 * read: read as empty, it would declare nothing, and no dependency would be
 * checked against the range it declares.
 */
async function readProjectPackageJson(projectDir: string): Promise<unknown> {
  const path = join(projectDir, "package.json");
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    throw markErrorPaths(
      new UserError(
        `Could not read ${path}, so push cannot tell which dependencies it ` +
          `declares: ${error instanceof Error ? error.message : error}`,
      ),
      [path],
    );
  }
}

/** A JSON file's value; undefined when it cannot be read or parsed. */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * The installed version of each `npm:` import a local module writes, and of
 * each import-map target, that Deno read from node_modules rather than the
 * registry: the bundle holds that copy, so push pins it (swamp-club#3970).
 */
async function installedPackageVersionsOf(
  json: unknown,
  bareImports: readonly ResolvedBareImport[],
): Promise<PackageVersions> {
  const rootDir = denoInfoRootDir(json);
  const raw = (json as { modules?: DenoInfoModule[] })?.modules;
  const versions: Record<string, PackageVersion> = {};
  const installedAt = async (
    specifier: string,
    target: string | undefined,
  ): Promise<void> => {
    if (specifier in versions || !target?.startsWith("file:")) return;
    const pkg = installedPackageDir(fromFileUrl(target));
    if (!pkg) return;
    const version = (await readJson(join(pkg.dir, "package.json")) as {
      version?: unknown;
    } | undefined)?.version;
    if (typeof version !== "string") return;
    const resolved = installedPackageVersion(specifier, pkg.name, version);
    if (resolved) versions[specifier] = resolved;
  };
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!isLocalModuleSpecifier(m.specifier, rootDir)) continue;
    const importer = fromFileUrl(m.specifier);
    for (const dep of m.dependencies ?? []) {
      const target = dep.code?.specifier ?? dep.type?.specifier;
      if (dep.specifier?.startsWith("npm:")) {
        await installedAt(dep.specifier, target);
      }
      const mapped = bareImports.find((b) =>
        dep.specifier === b.specifier && importer === b.importer
      )?.target;
      if (mapped?.startsWith("npm:")) await installedAt(mapped, target);
    }
  }
  return versions;
}

/** `sha256:<hex>` of a file's bytes; undefined when it cannot be read. */
async function fileSha256(path: string): Promise<string | undefined> {
  try {
    return `sha256:${await sha256Hex(await Deno.readFile(path))}`;
  } catch {
    return undefined;
  }
}

/** The `file:` modules of a `deno info` graph, as paths. */
function fileModulePaths(json: unknown): string[] {
  const raw = (json as { modules?: DenoInfoModule[] })?.modules;
  return (Array.isArray(raw) ? raw : []).flatMap((m) =>
    typeof m.specifier === "string" && m.specifier.startsWith("file:")
      ? [fromFileUrl(m.specifier)]
      : []
  );
}

/**
 * The package directory, at the first node_modules on its path from the
 * entry point's directory, of every installed module the graph reads: a
 * repository under a directory named node_modules is not taken for one.
 */
function nodeModulesPackageDirsOf(json: unknown): string[] {
  const rootDir = denoInfoRootDir(json);
  if (rootDir === undefined) return [];
  const dirs = new Set<string>();
  for (const path of fileModulePaths(json)) {
    const parts = relative(rootDir, path).split(SEPARATOR_PATTERN);
    const at = parts.indexOf("node_modules");
    if (at < 0) continue;
    const length = parts[at + 1]?.startsWith("@") ? 2 : 1;
    if (parts.length <= at + length) continue;
    dirs.add(resolve(rootDir, ...parts.slice(0, at + 1 + length)));
  }
  return [...dirs].sort();
}

/**
 * The `jsr:` imports naming a dist-tag: written in a local module, or what
 * the project's import map resolves a bare import to.
 */
function jsrDistTagsOf(
  json: unknown,
  bareImports: readonly ResolvedBareImport[],
): DistTaggedJsrImport[] {
  const rootDir = denoInfoRootDir(json);
  const raw = (json as { modules?: DenoInfoModule[] })?.modules;
  const found = new Map<string, DistTaggedJsrImport>();
  const add = (importer: string, specifier: string) => {
    const tag = jsrDistTag(specifier);
    if (tag) {
      found.set(`${importer}\0${specifier}`, { importer, specifier, tag });
    }
  };
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!isLocalModuleSpecifier(m.specifier, rootDir)) continue;
    for (const dep of m.dependencies ?? []) {
      if (dep.specifier) add(fromFileUrl(m.specifier), dep.specifier);
    }
  }
  for (const b of bareImports) {
    if (b.target) add(b.importer, b.target);
  }
  return [...found.values()];
}

/** A path from `dir`, with forward slashes. */
function relativeForward(dir: string, path: string): string {
  return relative(dir, path).split(SEPARATOR).join("/");
}

/**
 * Every package the graph takes from a node_modules below `packageDir`,
 * transitive ones included, with the version its package.json names.
 */
async function installedPackagesOf(
  json: unknown,
  packageDir: string,
): Promise<InstalledPackage[]> {
  const dirs = new Set<string>();
  for (const path of fileModulePaths(json)) {
    const rel = relative(packageDir, path);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const pkg = installedPackageDir(path);
    if (pkg) dirs.add(pkg.dir);
  }
  const packages: InstalledPackage[] = [];
  for (const dir of [...dirs].sort()) {
    const version = (await readJson(join(dir, "package.json")) as {
      version?: unknown;
    } | undefined)?.version;
    if (typeof version === "string") {
      packages.push({ path: relativeForward(packageDir, dir), version });
    }
  }
  return packages;
}

/**
 * Code the graph holds from outside npm and JSR: each URL a local module
 * imports with the modules fetched through it, and in a package.json
 * project each dependency installed from a path, a workspace or git with
 * the modules the graph reads from it. Every module carries a SHA-256 of
 * the copy Deno read; a module keys by its URL or its path from the
 * package.json directory, never by a local absolute path.
 */
async function unauditedCodeOf(
  json: unknown,
  packageProject: { dir: string; packageJson: unknown } | undefined,
): Promise<UnauditedDependency[]> {
  const rootDir = denoInfoRootDir(json);
  const unaudited: UnauditedDependency[] = [];
  for (
    const closure of urlImportClosures(
      json,
      (specifier) => isLocalModuleSpecifier(specifier, rootDir),
    )
  ) {
    const modules: Record<string, string> = {};
    for (const m of closure.modules) {
      const sha = m.local ? await fileSha256(m.local) : undefined;
      if (sha) modules[m.url] = sha;
    }
    unaudited.push({ kind: "url", origin: closure.origin, modules });
  }
  if (packageProject) {
    const paths = fileModulePaths(json);
    for (const dep of nonRegistryDependencies(packageProject.packageJson)) {
      const prefix = join(packageProject.dir, "node_modules", dep.name) +
        SEPARATOR;
      const modules: Record<string, string> = {};
      for (const path of paths.filter((p) => p.startsWith(prefix)).sort()) {
        const sha = await fileSha256(path);
        if (sha) modules[relativeForward(packageProject.dir, path)] = sha;
      }
      if (Object.keys(modules).length > 0) {
        unaudited.push({ kind: dep.kind, origin: dep.spec, modules });
      }
    }
  }
  return unaudited;
}

/**
 * Reads an entry point's module graph with `deno info --json`, run with the
 * same project flags, working directory and environment as `deno bundle`, so
 * the graph is the one the bundle is built from.
 */
export class DenoInfoModuleGraphReader implements ModuleGraphReader {
  /**
   * @param options.readOnlyLock - Never write the project's lockfile, as push
   *   and quality bundle: `--frozen` when it has one, `--no-lock` when not.
   * @param options.readPastStaleLock - With `readOnlyLock`, read the graph
   *   again with `--no-lock` when the lock is stale, instead of failing, as
   *   the extension loader does (swamp-club#3869).
   */
  constructor(
    private readonly denoPath: string,
    private readonly env?: Record<string, string>,
    private readonly options?: {
      readOnlyLock?: boolean;
      readPastStaleLock?: boolean;
    },
  ) {}

  async read(
    entryPoint: string,
    project: ModuleGraphProject,
  ): Promise<SourceModuleGraph> {
    const readOnlyLock = this.options?.readOnlyLock
      ? await readOnlyLockFor(project)
      : undefined;
    return await this.readGraph(entryPoint, project, readOnlyLock);
  }

  private async readGraph(
    entryPoint: string,
    project: ModuleGraphProject,
    readOnlyLock: ReadOnlyLock | undefined,
  ): Promise<SourceModuleGraph> {
    const result = await runDenoInfo(
      this.denoPath,
      toFileUrl(entryPoint).href,
      entryPoint,
      {
        args: denoProjectArgs({ ...project, readOnlyLock }),
        ...(project.packageJsonDir ? { cwd: project.packageJsonDir } : {}),
        ...(this.env ? { env: this.env } : {}),
      },
    );
    if (!result.success) {
      const stderr = result.stderr;
      if (readOnlyLock?.lockPath && isStaleLockfile(stderr)) {
        if (this.options?.readPastStaleLock) {
          return await this.readGraph(entryPoint, project, {});
        }
        throw staleLockfileError(
          readOnlyLock.lockPath,
          entryPoint,
          project,
          stderr,
        );
      }
      const details = stripAnsiCode(stderr.trim()) ||
        `deno info exited with code ${result.code}`;
      throw markErrorPaths(
        new UserError(
          `Could not read the module graph of ${entryPoint}, so push cannot ` +
            `tell which local modules to include: ${details}`,
        ),
        [entryPoint],
      );
    }
    const json = result.graph.json;
    const graph = await parseDenoInfoGraph(json, {
      exists: fileExists,
      readText: (path) => Deno.readTextFile(path).catch(() => undefined),
    });
    // The entry point is always a local file, so a graph without one means
    // deno info resolved something else; pushing on would publish an archive
    // without its sources.
    if (graph.modules.length === 0 && graph.missing.length === 0) {
      throw markErrorPaths(
        new UserError(
          `deno info listed no local module for ${entryPoint}, so push cannot ` +
            `tell which local modules to include. Check that the project's ` +
            `import map does not remap the entry point's path`,
        ),
        [entryPoint],
      );
    }
    let packageJson: unknown;
    if (!project.denoConfigPath && project.packageJsonDir) {
      // Read as installed (--node-modules-dir=manual), a bare import names a
      // file in node_modules; name the package installed there instead
      // (swamp-club#3630).
      packageJson = await readProjectPackageJson(project.packageJsonDir);
      const installed = await installedPackageImports(
        graph.bareImports ?? [],
        packageJson,
        (dir) => readJson(join(dir, "package.json")),
      );
      graph.bareImports = installed.resolutions;
      if (installed.stale.length > 0) graph.staleInstalls = installed.stale;
      graph.installedPackages = await installedPackagesOf(
        json,
        project.packageJsonDir,
      );
    }
    if (
      project.denoConfigPath &&
      hasUnresolvedBareImports(graph.bareImports ?? [])
    ) {
      graph.bareImports = withPackageSpecifiers(
        graph.bareImports ?? [],
        await this.readPackageSpecifiers(entryPoint, project),
      );
    }
    // The exact versions push pins in the archive's source, and the code
    // from outside npm and JSR it lists as unaudited (swamp-club#3970).
    graph.packageVersions = {
      ...await installedPackageVersionsOf(json, graph.bareImports ?? []),
      ...packageVersionsFromDenoInfo(json),
    };
    const unaudited = await unauditedCodeOf(
      json,
      project.packageJsonDir && !project.denoConfigPath
        ? { dir: project.packageJsonDir, packageJson }
        : undefined,
    );
    if (unaudited.length > 0) graph.unaudited = unaudited;
    // What push refuses before bundling (swamp-club#3971).
    const packageDirs = nodeModulesPackageDirsOf(json);
    if (packageDirs.length > 0) graph.nodeModulesPackageDirs = packageDirs;
    const distTags = jsrDistTagsOf(json, graph.bareImports ?? []);
    if (distTags.length > 0) graph.jsrDistTags = distTags;
    return graph;
  }

  /**
   * The bare imports read again with `--node-modules-dir=none`, so a name
   * the config maps to an npm package reads as that specifier rather than
   * as missing from, or a file in, node_modules (swamp-club#3612). None when
   * that read fails: the first read's answer stands.
   */
  private async readPackageSpecifiers(
    entryPoint: string,
    project: ModuleGraphProject,
  ): Promise<ResolvedBareImport[]> {
    try {
      const result = await runDenoInfo(
        this.denoPath,
        toFileUrl(entryPoint).href,
        entryPoint,
        {
          // A resolution query only: a lock written under a manual
          // node_modules may lack the entries this mode wants, so the read
          // never freezes or writes it. The bundle keeps its lock flags.
          args: [
            ...denoProjectArgs({ ...project, readOnlyLock: {} }),
            "--node-modules-dir=none",
          ],
          ...(this.env ? { env: this.env } : {}),
        },
      );
      if (!result.success) return [];
      return bareImportsFromDenoInfo(result.graph.json);
    } catch {
      return [];
    }
  }
}

/** Builds a {@link DenoInfoModuleGraphReader} for the extension loader. */
export const createDenoInfoModuleGraphReader: ModuleGraphReaderFactory = (
  denoPath,
  env,
) =>
  new DenoInfoModuleGraphReader(denoPath, env, {
    readOnlyLock: true,
    readPastStaleLock: true,
  });
