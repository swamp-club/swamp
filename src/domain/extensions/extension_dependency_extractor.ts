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

import { importMapTarget, isBareSpecifier } from "../models/bundle.ts";
import {
  type DependencySpecifier,
  parseSpecifier,
  specifierKey,
  writtenSpecifiers,
} from "@swamp-club/extension-scoring/dependency-audit";
import {
  importedSpecifiers,
  importedSpecifiersAt,
  stripSourceComments,
} from "@swamp-club/extension-scoring/source";
import type { BareImportResolver } from "./bare_import_resolution.ts";
import { LineIndex } from "./extension_source_ast.ts";
import type { SpecifierSpan } from "./extension_source_graph.ts";

/** A `deno.json` `imports` object. */
export type ImportMap = Record<string, string>;

/** An import specifier as the source writes it, and where. */
export interface ImportSpecifierSite {
  specifier: string;
  /** Quotes included; zero-based line, code-point columns. */
  span: SpecifierSpan;
  /** UTF-16 offset of the opening quote in the source. */
  offset: number;
}

/**
 * Every import specifier `source` writes in import position, with its span,
 * read the way the dependency audit reads them: comments and template
 * literals blanked, string literals read as tokens. An unterminated
 * literal is left out — it has no span to rewrite.
 */
export function findImportSpecifiers(source: string): ImportSpecifierSite[] {
  const lines = new LineIndex(source);
  const sourceLines = source.split("\n");
  const at = (offset: number) => {
    const { line, column } = lines.position(offset);
    const text = sourceLines[line - 1];
    return {
      line: line - 1,
      character: Array.from(text.slice(0, column - 1)).length,
    };
  };
  return importedSpecifiersAt(stripSourceComments(source))
    .filter((s) => s.terminated)
    .map((s) => ({
      specifier: s.specifier,
      span: { start: at(s.start), end: at(s.end) },
      offset: s.start,
    }));
}

/**
 * What the import map resolves a bare specifier to, as the bundler
 * resolves it: {@link importMapTarget}, where a key mapped to an `npm:` or
 * `jsr:` package also covers its subpaths (`"@std/path"` resolves
 * `@std/path/posix`) unless the map has its own `key/` entry, as Deno
 * expands it.
 */
export function resolveBareImport(
  specifier: string,
  imports: ImportMap,
): string | undefined {
  const expanded: ImportMap = { ...imports };
  for (const [key, target] of Object.entries(imports)) {
    if (
      !key.endsWith("/") && typeof target === "string" &&
      /^(?:npm|jsr):/.test(target) && !Object.hasOwn(imports, `${key}/`)
    ) {
      expanded[`${key}/`] = `${target}/`;
    }
  }
  return importMapTarget(specifier, expanded);
}

/**
 * A resolver reading only an `imports` record, the same for every importer:
 * no scopes, no `importMap` file. For tests and callers that hold no module
 * graph; push resolves through the graph (swamp-club#3612).
 */
export function importMapResolver(imports: ImportMap): BareImportResolver {
  return {
    resolve: (_importer, specifier) => resolveBareImport(specifier, imports),
  };
}

/**
 * The `npm:` and `jsr:` dependencies a module imports: those it writes
 * out, and, given a resolver, the bare imports it resolves to one from
 * `sourceFile`. A dependency written both ways keeps the written form.
 */
export function extractSpecifiersFromSource(
  source: string,
  sourceFile: string,
  resolver?: BareImportResolver,
): DependencySpecifier[] {
  const results = writtenSpecifiers(source, sourceFile);
  const seen = new Set(results.map(specifierKey));

  if (!resolver) return results;

  // Bare names are read as the bare-specifiers rule reads them, with
  // template literals blanked, so generated code is never audited.
  for (const bare of importedSpecifiers(source)) {
    if (!bare || !isBareSpecifier(bare)) continue;
    const target = resolver.resolve(sourceFile, bare);
    if (!target) continue;
    // A `key/` entry must write its target `npm:/name@v/` for Deno to
    // resolve it; the package is the same.
    const resolved = parseSpecifier(target.replace(/^(npm|jsr):\//, "$1:"));
    if (!resolved) continue;
    // An installed package.json dependency ships its installed version and
    // is audited at the range package.json declares, if it declares one. A
    // declaration naming another package never replaces the one that ships.
    const installed = resolver.installed?.(sourceFile, bare);
    const declaredSpec = installed?.declared
      ? parseSpecifier(installed.declared)
      : null;
    const parsed = !installed
      ? resolved
      : declaredSpec && declaredSpec.name === resolved.name
      ? { ...declaredSpec, installedVersion: installed.version }
      : { ...resolved, installedVersion: installed.version };

    const key = specifierKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ ...parsed, sourceFile, importedAs: bare });
  }

  return results;
}

/**
 * The dependencies of `sourceFiles`, which are the code modules the module
 * graph reports (TypeScript or JavaScript in any extension), so every file
 * push rewrites bare imports in is audited too (swamp-club#3637).
 */
export async function extractDependencySpecifiers(
  sourceFiles: string[],
  resolver?: BareImportResolver,
): Promise<DependencySpecifier[]> {
  const seen = new Map<string, DependencySpecifier>();

  for (const file of sourceFiles) {
    let source: string;
    try {
      source = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    for (const spec of extractSpecifiersFromSource(source, file, resolver)) {
      // Each version of a package is audited: two specifiers, or two
      // installed copies, can ship two different versions. A written
      // specifier replaces a mapped one.
      const key = specifierKey(spec);
      const existing = seen.get(key);
      if (!existing || (existing.importedAs && !spec.importedAs)) {
        seen.set(key, spec);
      }
    }
  }

  return Array.from(seen.values());
}
