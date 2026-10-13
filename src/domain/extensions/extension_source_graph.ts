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
  for (const graph of graphs) {
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
      missing: graph.missing.filter((m) => keep(m.path)),
    },
    symlinked,
  };
}
