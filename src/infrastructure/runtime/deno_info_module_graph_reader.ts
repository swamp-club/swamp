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

import { fromFileUrl, join, toFileUrl } from "@std/path";
import { stripAnsiCode } from "@std/fmt/colors";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  denoProjectArgs,
  isStaleLockfile,
  staleLockfileError,
} from "../../domain/models/bundle.ts";
import { readOnlyLockFor } from "./deno_lockfile_reader.ts";
import {
  bareImportsFromDenoInfo,
  denoInfoRootDir,
  hasUnresolvedBareImports,
  installedPackageImports,
  isLocalModuleSpecifier,
  type ResolvedBareImport,
  withPackageSpecifiers,
} from "../../domain/extensions/bare_import_resolution.ts";
import type {
  LocalEdge,
  LocalModule,
  MissingLocalModule,
  ModuleGraphProject,
  ModuleGraphReader,
  ModuleGraphReaderFactory,
  SourceModuleGraph,
  SpecifierSpan,
} from "../../domain/extensions/extension_source_graph.ts";

/** Upper bound on one `deno info` run; it fetches remote modules on a cold cache. */
const DENO_INFO_TIMEOUT_MS = 5 * 60 * 1000;

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
 * Reads an entry point's module graph with `deno info --json`, run with the
 * same project flags, working directory and environment as `deno bundle`, so
 * the graph is the one the bundle is built from.
 */
export class DenoInfoModuleGraphReader implements ModuleGraphReader {
  /**
   * @param options.readOnlyLock - Never write the project's lockfile, as push
   *   and quality bundle: `--frozen` when it has one, `--no-lock` when not.
   */
  constructor(
    private readonly denoPath: string,
    private readonly env?: Record<string, string>,
    private readonly options?: { readOnlyLock?: boolean },
  ) {}

  async read(
    entryPoint: string,
    project: ModuleGraphProject,
  ): Promise<SourceModuleGraph> {
    const readOnlyLock = this.options?.readOnlyLock
      ? await readOnlyLockFor(project)
      : undefined;
    // A file URL, not the path: deno info resolves its argument through the
    // import map first, which reads a Windows path (C:\...) as a URL with
    // the scheme c: and reports it as an external module.
    const command = new Deno.Command(this.denoPath, {
      args: [
        "info",
        "--json",
        ...denoProjectArgs({ ...project, readOnlyLock }),
        toFileUrl(entryPoint).href,
      ],
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(DENO_INFO_TIMEOUT_MS),
      ...(project.packageJsonDir ? { cwd: project.packageJsonDir } : {}),
      ...(this.env ? { env: this.env } : {}),
    });
    const output = await command.output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      if (readOnlyLock?.lockPath && isStaleLockfile(stderr)) {
        throw staleLockfileError(
          readOnlyLock.lockPath,
          entryPoint,
          project,
          stderr,
        );
      }
      const details = stripAnsiCode(stderr.trim()) ||
        `deno info exited with code ${output.code}`;
      throw markErrorPaths(
        new UserError(
          `Could not read the module graph of ${entryPoint}, so push cannot ` +
            `tell which local modules to include: ${details}`,
        ),
        [entryPoint],
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(output.stdout));
    } catch (error) {
      throw new Error(
        `deno info returned invalid JSON for ${entryPoint}: ${error}`,
      );
    }
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
    if (!project.denoConfigPath && project.packageJsonDir) {
      // Read as installed (--node-modules-dir=manual), a bare import names a
      // file in node_modules; name the package installed there instead
      // (swamp-club#3630).
      const installed = await installedPackageImports(
        graph.bareImports ?? [],
        await readProjectPackageJson(project.packageJsonDir),
        (dir) => readJson(join(dir, "package.json")),
      );
      graph.bareImports = installed.resolutions;
      if (installed.stale.length > 0) graph.staleInstalls = installed.stale;
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
      const output = await new Deno.Command(this.denoPath, {
        args: [
          "info",
          "--json",
          // A resolution query only: a lock written under a manual
          // node_modules may lack the entries this mode wants, so the read
          // never freezes or writes it. The bundle keeps its lock flags.
          ...denoProjectArgs({ ...project, readOnlyLock: {} }),
          "--node-modules-dir=none",
          toFileUrl(entryPoint).href,
        ],
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(DENO_INFO_TIMEOUT_MS),
        ...(this.env ? { env: this.env } : {}),
      }).output();
      if (!output.success) return [];
      return bareImportsFromDenoInfo(
        JSON.parse(new TextDecoder().decode(output.stdout)),
      );
    } catch {
      return [];
    }
  }
}

/** Builds a {@link DenoInfoModuleGraphReader} for the extension loader. */
export const createDenoInfoModuleGraphReader: ModuleGraphReaderFactory = (
  denoPath,
  env,
) => new DenoInfoModuleGraphReader(denoPath, env);
