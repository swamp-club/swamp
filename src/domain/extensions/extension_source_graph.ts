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
