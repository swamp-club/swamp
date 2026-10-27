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
 * The local part of an extension entry point's module graph, as the bundler
 * sees it: every file the entry point reaches through a static or literal
 * dynamic import, a type import, or a JSON, text or bytes import. Push builds
 * the archive's source copy from this graph, so the source copy holds every
 * local module the bundle was built from (swamp-club#3376).
 */

import type { UnauditedDependency } from "@swamp-club/extension-scoring/dependency-audit";
import {
  mergePackageVersions,
  type PackageVersions,
} from "./dependency_resolution/package_versions.ts";
import {
  type ResolvedBareImport,
  type StaleInstalledImport,
  uniqueBareImports,
} from "./bare_import_resolution.ts";

/** Code modules are TypeScript or JavaScript; data modules are imported as JSON, text or bytes. */
export type LocalModuleKind = "code" | "data";

/** A position in a source file: zero-based line, and column in code points. */
export interface SourcePosition {
  line: number;
  character: number;
}

/** The span of an import specifier in its importer, quotes included. */
export interface SpecifierSpan {
  start: SourcePosition;
  end: SourcePosition;
}

/** A local file in the graph, by absolute path. */
export interface LocalModule {
  path: string;
  kind: LocalModuleKind;
}

/** One import of a local module by another local module. */
export interface LocalEdge {
  /** Absolute path of the importing module. */
  importer: string;
  /** Absolute path of the imported module. */
  target: string;
  /** The specifier as written in the importer. */
  specifier: string;
  span: SpecifierSpan;
}

/** A local module the graph reaches but cannot load. */
export interface MissingLocalModule {
  path: string;
  /** A module that imports it, when the graph names one. */
  importer?: string;
  reason: string;
}

export interface SourceModuleGraph {
  modules: LocalModule[];
  edges: LocalEdge[];
  missing: MissingLocalModule[];
  /**
   * The bare imports the local modules write, with what Deno resolved each
   * to; absent when the reader recorded none.
   */
  bareImports?: ResolvedBareImport[];
  /**
   * The bare imports a package.json project declares that node_modules does
   * not hold at a version package.json allows (swamp-club#3630); absent
   * when there are none.
   */
  staleInstalls?: StaleInstalledImport[];
  /**
   * The exact package each `npm:` and `jsr:` specifier resolved to, which
   * push pins in the archive's source (swamp-club#3970); absent when the
   * reader recorded none.
   */
  packageVersions?: PackageVersions;
  /**
   * Code from outside npm and JSR the graph fetched or installed, with a
   * SHA-256 of each module (swamp-club#3970); absent when there is none.
   */
  unaudited?: UnauditedDependency[];
  /**
   * Every package a package.json project's node_modules supplies to the
   * graph, transitive ones included, by its path from the package.json
   * directory (`node_modules/ms`, forward slashes) and installed version;
   * absent outside a package.json project (swamp-club#3970).
   */
  installedPackages?: InstalledPackage[];
}

/** A package installed in node_modules, and its version. */
export interface InstalledPackage {
  path: string;
  version: string;
}

/** The project configuration the bundler resolves modules under. */
export interface ModuleGraphProject {
  denoConfigPath?: string;
  packageJsonDir?: string;
}

/** Port: reads the local module graph of one entry point. */
export interface ModuleGraphReader {
  read(
    entryPoint: string,
    project: ModuleGraphProject,
  ): Promise<SourceModuleGraph>;
}

/**
 * Builds a {@link ModuleGraphReader} that runs the deno binary at
 * `denoPath` with `env`, for callers that resolve the binary only when
 * they first bundle.
 */
export type ModuleGraphReaderFactory = (
  denoPath: string,
  env: Record<string, string>,
) => ModuleGraphReader;

/**
 * Unions graphs, keeping the first occurrence of each module and each
 * edge. Edges are identified by importer and span, so the same import read
 * from two entry points counts once.
 */
export function mergeSourceGraphs(
  graphs: readonly SourceModuleGraph[],
): SourceModuleGraph {
  const modules = new Map<string, LocalModule>();
  const edges = new Map<string, LocalEdge>();
  const missing = new Map<string, MissingLocalModule>();
  const bareImports: ResolvedBareImport[] = [];
  const staleInstalls = new Map<string, StaleInstalledImport>();
  const unaudited = new Map<string, UnauditedDependency>();
  const installedPackages = new Map<string, InstalledPackage>();
  for (const graph of graphs) {
    for (const p of graph.installedPackages ?? []) {
      if (!installedPackages.has(p.path)) installedPackages.set(p.path, p);
    }
    for (const u of graph.unaudited ?? []) {
      const key = `${u.kind}\0${u.origin}`;
      const known = unaudited.get(key);
      unaudited.set(
        key,
        known ? { ...u, modules: { ...u.modules, ...known.modules } } : u,
      );
    }
    for (const b of graph.bareImports ?? []) bareImports.push(b);
    for (const s of graph.staleInstalls ?? []) {
      const key = `${s.importer}\0${s.specifier}`;
      if (!staleInstalls.has(key)) staleInstalls.set(key, s);
    }
    for (const m of graph.modules) {
      if (!modules.has(m.path)) modules.set(m.path, m);
    }
    for (const e of graph.edges) {
      const key =
        `${e.importer}\0${e.span.start.line}:${e.span.start.character}`;
      if (!edges.has(key)) edges.set(key, e);
    }
    for (const m of graph.missing) {
      if (!missing.has(m.path)) missing.set(m.path, m);
    }
  }
  return {
    modules: [...modules.values()],
    edges: [...edges.values()],
    missing: [...missing.values()],
    bareImports: uniqueBareImports(bareImports),
    ...(staleInstalls.size > 0
      ? { staleInstalls: [...staleInstalls.values()] }
      : {}),
    ...(graphs.some((g) => g.packageVersions)
      ? {
        packageVersions: mergePackageVersions(
          graphs.map((g) => g.packageVersions),
        ),
      }
      : {}),
    ...(unaudited.size > 0 ? { unaudited: [...unaudited.values()] } : {}),
    ...(graphs.some((g) => g.installedPackages)
      ? {
        installedPackages: [...installedPackages.values()].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0
        ),
      }
      : {}),
  };
}

/** One entry point's graph with its symlinked modules removed. */
export interface SymlinkFreeGraph {
  graph: SourceModuleGraph;
  /**
   * The symlinks the root reaches without passing through another one, so
   * the safety gate can refuse each by the symlink rule. A symlink the graph
   * could not load is listed as code (its kind is unknown).
   */
  symlinked: LocalModule[];
}

/**
 * Removes every symlink from one entry point's graph, together with each
 * module, edge and missing module the root reaches only through one, so
 * nothing read from a symlink's target — its imports, or the error text the
 * graph recorded for it, which quotes its source — is used or shown
 * (swamp-club#3420). A module no edge leads to is kept, as before.
 */
export function withoutSymlinkedModules(
  graph: SourceModuleGraph,
  root: string,
  symlinks: ReadonlySet<string>,
): SymlinkFreeGraph {
  const kindOf = new Map<string, LocalModuleKind>(
    graph.modules.map((m) => [m.path, m.kind]),
  );
  if (symlinks.has(root)) {
    return {
      graph: { modules: [], edges: [], missing: [] },
      symlinked: [{ path: root, kind: kindOf.get(root) ?? "code" }],
    };
  }
  const reach = (through: (path: string) => boolean): Set<string> => {
    const reached = new Set([root]);
    const queue = [root];
    while (queue.length > 0) {
      const importer = queue.shift()!;
      for (const e of graph.edges) {
        if (e.importer !== importer || reached.has(e.target)) continue;
        reached.add(e.target);
        if (through(e.target)) queue.push(e.target);
      }
    }
    return reached;
  };
  // What the root reaches through any module, and what it reaches without
  // passing through a symlink: the difference hangs off a symlink.
  const all = reach(() => true);
  const clean = reach((path) => !symlinks.has(path));
  const keep = (path: string) =>
    !symlinks.has(path) && (clean.has(path) || !all.has(path));
  const symlinked = [...clean].filter((path) => symlinks.has(path)).sort()
    .map((path) => ({ path, kind: kindOf.get(path) ?? "code" as const }));
  return {
    graph: {
      modules: graph.modules.filter((m) => keep(m.path)),
      edges: graph.edges.filter((e) => keep(e.importer) && keep(e.target)),
      // With a symlink in the graph, a missing module is kept only when the
      // root reaches it cleanly: its error text could come from a target.
      missing: graph.missing.filter((m) =>
        symlinks.size > 0
          ? clean.has(m.path) && !symlinks.has(m.path)
          : keep(m.path)
      ),
      ...(graph.bareImports
        ? { bareImports: graph.bareImports.filter((b) => keep(b.importer)) }
        : {}),
      ...(graph.staleInstalls
        ? {
          staleInstalls: graph.staleInstalls.filter((s) => keep(s.importer)),
        }
        : {}),
      ...(graph.packageVersions
        ? { packageVersions: graph.packageVersions }
        : {}),
      ...(graph.unaudited ? { unaudited: graph.unaudited } : {}),
      ...(graph.installedPackages
        ? { installedPackages: graph.installedPackages }
        : {}),
    },
    symlinked,
  };
}
