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
 * push builds the archive's source copy from this graph, so the copy holds
 * every local module the bundle was built from
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

export type LocalModuleKind = "code" | "data";

export interface SourcePosition {
  line: number;
  character: number;
}

export interface SpecifierSpan {
  start: SourcePosition;
  end: SourcePosition;
}

export interface LocalModule {
  path: string;
  kind: LocalModuleKind;
}

export interface LocalEdge {
  importer: string;
  target: string;
  specifier: string;
  span: SpecifierSpan;
}

export interface MissingLocalModule {
  path: string;
  importer?: string;
  reason: string;
}

export interface SourceModuleGraph {
  modules: LocalModule[];
  edges: LocalEdge[];
  missing: MissingLocalModule[];
  bareImports?: ResolvedBareImport[];
  staleInstalls?: StaleInstalledImport[];
  /**
   * the exact package each npm: and jsr: specifier resolved to, which push pins
   * in the archive's source; absent when the reader recorded none
   */
  packageVersions?: PackageVersions;
  unaudited?: UnauditedDependency[];
  /**
   * every package node_modules supplies to the graph, transitive included, by
   * path from the package.json directory (forward slashes); absent outside a
   * package.json project
   */
  installedPackages?: InstalledPackage[];
  /**
   * each package directory a module is read from, taken at the first
   * node_modules on its path; push refuses one above the repository
   */
  nodeModulesPackageDirs?: string[];
  /**
   * jsr: imports naming a dist-tag such as @latest, which JSR does not have;
   * absent when there are none
   */
  jsrDistTags?: DistTaggedJsrImport[];
}

export interface DistTaggedJsrImport {
  importer: string;
  specifier: string;
  tag: string;
}

export interface InstalledPackage {
  path: string;
  version: string;
}

export interface ModuleGraphProject {
  denoConfigPath?: string;
  packageJsonDir?: string;
  /** the workspace root whose lock a member reads */
  workspaceRootConfigPath?: string;
  noConfig?: boolean;
}

export interface ModuleGraphReader {
  read(
    entryPoint: string,
    project: ModuleGraphProject,
  ): Promise<SourceModuleGraph>;
}

export type ModuleGraphReaderFactory = (
  denoPath: string,
  env: Record<string, string>,
) => ModuleGraphReader;

/**
 * keeps the first occurrence of each module and edge; edges are identified by
 * importer and span, so the same import read from two entry points counts once
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
  const nodeModulesPackageDirs = new Set<string>();
  const jsrDistTags = new Map<string, DistTaggedJsrImport>();
  for (const graph of graphs) {
    for (const d of graph.nodeModulesPackageDirs ?? []) {
      nodeModulesPackageDirs.add(d);
    }
    for (const j of graph.jsrDistTags ?? []) {
      jsrDistTags.set(`${j.importer}\0${j.specifier}`, j);
    }
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
    ...(nodeModulesPackageDirs.size > 0
      ? { nodeModulesPackageDirs: [...nodeModulesPackageDirs].sort() }
      : {}),
    ...(jsrDistTags.size > 0 ? { jsrDistTags: [...jsrDistTags.values()] } : {}),
    ...(graphs.some((g) => g.installedPackages)
      ? {
        installedPackages: [...installedPackages.values()].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0
        ),
      }
      : {}),
  };
}

export interface SymlinkFreeGraph {
  graph: SourceModuleGraph;
  /**
   * symlinks the root reaches without passing through another, so the safety
   * gate can refuse each; one the graph could not load is listed as code
   */
  symlinked: LocalModule[];
}

/**
 * removes symlinks and everything reached only through one, so nothing read
 * from a symlink's target, including recorded error text that quotes its
 * source, is used or shown
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
      ...(graph.nodeModulesPackageDirs
        ? { nodeModulesPackageDirs: graph.nodeModulesPackageDirs }
        : {}),
      ...(graph.jsrDistTags
        ? { jsrDistTags: graph.jsrDistTags.filter((j) => keep(j.importer)) }
        : {}),
    },
    symlinked,
  };
}
