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
  importMapTarget,
  isBareSpecifier,
  stripSourceComments,
} from "../models/bundle.ts";
import type { BareImportResolver } from "./bare_import_resolution.ts";
import { LineIndex } from "./extension_source_ast.ts";
import type { SpecifierSpan } from "./extension_source_graph.ts";

export interface DependencySpecifier {
  name: string;
  version: string | null;
  registry: "npm" | "jsr";
  sourceFile: string;
  /**
   * The bare specifier the source wrote, when the import map resolved it
   * to this one; absent for an import written as `npm:` or `jsr:`.
   */
  importedAs?: string;
  /**
   * The version installed in a package.json project's node_modules, which
   * the bundle inlines, when the import resolved to it; `version` is then
   * the range package.json declares (swamp-club#3630).
   */
  installedVersion?: string;
}

/** A `deno.json` `imports` object. */
export type ImportMap = Record<string, string>;

function stripComments(source: string): string {
  const lines = source.split("\n");
  const result: string[] = [];
  let inBlockComment = false;

  for (const line of lines) {
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end !== -1) {
        inBlockComment = false;
        result.push(line.slice(end + 2));
      }
      continue;
    }

    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      const blockEnd = line.indexOf("*/", blockStart + 2);
      if (blockEnd !== -1) {
        result.push(line.slice(0, blockStart) + line.slice(blockEnd + 2));
      } else {
        inBlockComment = true;
        result.push(line.slice(0, blockStart));
      }
      continue;
    }

    // Only strip // comments on lines containing import/export keywords
    // to avoid false-stripping URLs in string literals
    if (/\b(?:import|export)\b/.test(line)) {
      const lineComment = line.indexOf("//");
      if (lineComment !== -1) {
        result.push(line.slice(0, lineComment));
        continue;
      }
    }

    result.push(line);
  }

  return result.join("\n");
}

// Matches static imports: `from "npm:..."` and side-effect `import "npm:..."`
const STATIC_IMPORT_RE =
  /(?:from|import)\s+["'](?<specifier>(?:npm|jsr):[^"']+)["']/g;

// Matches dynamic imports: `import("npm:...")`
const DYNAMIC_IMPORT_RE =
  /import\s*\(\s*["'](?<specifier>(?:npm|jsr):[^"']+)["']\s*\)/g;

// The code before a string literal that puts it in import position:
// `import ... from`/`export ... from`, side-effect `import`, `import(`
const IMPORT_POSITION_RE =
  /(?:^|[^.\w$])(?:(?:import|export)\b[^;]*\bfrom|import)\s*$|(?:^|[^.\w$])import\s*\(\s*$/;

/** A quoted specifier in import position, by UTF-16 offsets of its quotes. */
interface ImportedSpecifierAt {
  specifier: string;
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote; the line end when unterminated. */
  end: number;
  terminated: boolean;
}

/**
 * The quoted specifiers in import position. Each string literal is read as
 * a token, so text inside a string (`"run: import x from 'y'"`) is never
 * taken for an import, and only the code between it and the previous
 * literal is matched.
 */
function importedSpecifiersAt(code: string): ImportedSpecifierAt[] {
  const specifiers: ImportedSpecifierAt[] = [];
  let codeStart = 0;
  let i = 0;
  while (i < code.length) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'") {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < code.length && code[end] !== quote && code[end] !== "\n") {
      end += code[end] === "\\" ? 2 : 1;
    }
    if (IMPORT_POSITION_RE.test(code.slice(codeStart, i))) {
      const terminated = code[end] === quote;
      specifiers.push({
        specifier: code.slice(i + 1, end),
        start: i,
        end: terminated ? end + 1 : end,
        terminated,
      });
    }
    i = end + 1;
    codeStart = i;
  }
  return specifiers;
}

function importedSpecifiers(code: string): string[] {
  return importedSpecifiersAt(code).map((s) => s.specifier);
}

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

// Parses `npm:@scope/name@version`, `npm:name@version`, `npm:name`
const NPM_SPECIFIER_RE =
  /^npm:(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]+))?/;

// Parses `jsr:@scope/name@version`, `jsr:@scope/name`
const JSR_SPECIFIER_RE = /^jsr:(?<name>@[^/@]+\/[^/@]+)(?:@(?<version>[^/]+))?/;

// zod is externalized by the bundler — not a real extension dependency
const EXCLUDED_PACKAGES = new Set(["zod"]);

function parseSpecifier(
  raw: string,
): { name: string; version: string | null; registry: "npm" | "jsr" } | null {
  if (raw.startsWith("npm:")) {
    const match = NPM_SPECIFIER_RE.exec(raw);
    if (!match?.groups) return null;
    const name = match.groups.name;
    if (EXCLUDED_PACKAGES.has(name)) return null;
    return { name, version: match.groups.version ?? null, registry: "npm" };
  }
  if (raw.startsWith("jsr:")) {
    const match = JSR_SPECIFIER_RE.exec(raw);
    if (!match?.groups) return null;
    return {
      name: match.groups.name,
      version: match.groups.version ?? null,
      registry: "jsr",
    };
  }
  return null;
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

function specifierKey(
  spec: { registry: string; name: string; version: string | null },
): string {
  return `${spec.registry}:${spec.name}@${spec.version ?? ""}`;
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
  const seen = new Set<string>();
  const results: DependencySpecifier[] = [];
  const stripped = stripComments(source);

  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const match of stripped.matchAll(re)) {
      const raw = match.groups?.specifier;
      if (!raw) continue;
      const parsed = parseSpecifier(raw);
      if (!parsed) continue;

      const key = specifierKey(parsed);
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({ ...parsed, sourceFile });
    }
  }

  if (!resolver) return results;

  // Bare names are read as the bare-specifiers rule reads them, with
  // template literals blanked, so generated code is never audited.
  for (const bare of importedSpecifiers(stripSourceComments(source))) {
    if (!bare || !isBareSpecifier(bare)) continue;
    const target = resolver.resolve(sourceFile, bare);
    if (!target) continue;
    // A `key/` entry must write its target `npm:/name@v/` for Deno to
    // resolve it; the package is the same.
    const resolved = parseSpecifier(target.replace(/^(npm|jsr):\//, "$1:"));
    if (!resolved) continue;
    // An installed package.json dependency: audit the range package.json
    // declares, shipping the installed version.
    const declared = resolver.declared?.(sourceFile, bare);
    const declaredSpec = declared ? parseSpecifier(declared) : null;
    const parsed = declaredSpec && resolved.version !== null
      ? { ...declaredSpec, installedVersion: resolved.version }
      : resolved;

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
      // Each version of a package is audited: two specifiers can ship two
      // different versions. A written specifier replaces a mapped one.
      const key = specifierKey(spec);
      const existing = seen.get(key);
      if (!existing || (existing.importedAs && !spec.importedAs)) {
        seen.set(key, spec);
      }
    }
  }

  return Array.from(seen.values());
}
