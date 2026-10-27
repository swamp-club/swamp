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
 * The one way extension source is parsed. The import scan, swamp's safety
 * rules and its quality-ignore directive reader all parse with these
 * options, so a module reads the same to every one of them, on the CLI and
 * on the registry.
 *
 * @module
 */

import { parse, type ParserOptions, type ParserPlugin } from "@babel/parser";
import { extname } from "@std/path";

/** A syntax-tree node, as far as a reader of extension source needs it. */
export interface SyntaxNode {
  type: string;
  start?: number | null;
  end?: number | null;
  [key: string]: unknown;
}

/** A comment or token Babel found, by UTF-16 offsets into the source. */
export interface SourceSpan {
  type?: unknown;
  value?: unknown;
  start?: number | null;
  end?: number | null;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  } | null;
}

/** A module that parsed. */
export interface ParsedModule {
  ok: true;
  program: SyntaxNode;
  comments: SourceSpan[];
  /** Empty unless {@link ParseModuleOptions.tokens} was asked for. */
  tokens: SourceSpan[];
}

/** A module that did not parse, and Babel's reason with its position. */
export interface UnparsedModule {
  ok: false;
  reason: string;
}

/** How {@link parseExtensionModule} reads a module. */
export interface ParseModuleOptions {
  /**
   * The module's path, which picks the syntax: TypeScript for `.ts`, `.mts`,
   * `.cts` and `.tsx`, JavaScript for `.js`, `.mjs`, `.cjs` and `.jsx`, and
   * JSX for the `x` extensions. Without one the module is read as
   * TypeScript.
   */
  path?: string;
  /**
   * Read the module as `deno bundle` output rather than as source an
   * author wrote: JavaScript with the TC39 decorator syntax and the import
   * proposals a bundler can leave, recovering from errors where Babel can.
   */
  bundle?: boolean;
  /** Also return the tokens. */
  tokens?: boolean;
}

// Syntax extension source is written in, beside the language itself.
// Decorators are read in their legacy form first: TypeScript's
// `experimentalDecorators` allows parameter decorators, which the TC39
// plugin refuses.
const SOURCE_PLUGINS: ParserPlugin[] = [
  "decorators-legacy",
  "explicitResourceManagement",
  "decoratorAutoAccessors",
  "importAttributes",
];

// A module the legacy form refuses is read again with TC39 decorators,
// which Deno also runs and which allow `export @dec class`.
const TC39_DECORATORS: ParserPlugin = "decorators";

// Syntax esbuild can leave in a bundle that Babel does not parse by default.
// `decorators` and `decorators-legacy` cannot be combined, so a bundle is
// read with its own set.
const BUNDLE_PLUGINS: ParserPlugin[] = [
  "importAttributes",
  "explicitResourceManagement",
  "decorators",
  "decoratorAutoAccessors",
  "sourcePhaseImports",
  "deferredImportEvaluation",
];

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx"]);

// CommonJS runs as a script, in sloppy mode.
const COMMONJS_EXTENSIONS = new Set([".cjs", ".cts"]);

function extensionOf(path?: string): string {
  return path === undefined ? ".ts" : extname(path).toLowerCase();
}

/**
 * The Babel plugins a module at `path` is parsed with. JavaScript is read
 * without the TypeScript plugin, which refuses some valid JavaScript.
 */
export function parserPluginsFor(path?: string): ParserPlugin[] {
  const ext = extensionOf(path);
  const plugins: ParserPlugin[] = JAVASCRIPT_EXTENSIONS.has(ext)
    ? [...SOURCE_PLUGINS]
    : ["typescript", ...SOURCE_PLUGINS];
  if (ext.endsWith("x")) plugins.push("jsx");
  return plugins;
}

/**
 * Parses `source` as a module. Never throws: a syntax error, and a stack
 * overflow on extreme nesting, come back as an {@link UnparsedModule}.
 * Module only, apart from CommonJS (`.cjs`, `.cts`), which is read as a
 * script: Deno runs extensions as modules, and a script-mode retry would
 * read `<!--` as a comment, which in a module is live code.
 */
export function parseExtensionModule(
  source: string,
  options: ParseModuleOptions = {},
): ParsedModule | UnparsedModule {
  if (options.bundle) return parseWith(source, BUNDLE_PLUGINS, options);
  const plugins = parserPluginsFor(options.path);
  const parsed = parseWith(source, plugins, options);
  if (parsed.ok || !source.includes("@")) return parsed;
  const tc39 = plugins.map((plugin) =>
    plugin === "decorators-legacy" ? TC39_DECORATORS : plugin
  );
  const retried = parseWith(source, tc39, options);
  // A module neither form reads reports the legacy form's reason.
  return retried.ok ? retried : parsed;
}

function parseWith(
  source: string,
  plugins: ParserPlugin[],
  options: ParseModuleOptions,
): ParsedModule | UnparsedModule {
  const commonJs = !options.bundle &&
    COMMONJS_EXTENSIONS.has(extensionOf(options.path));
  const parserOptions: ParserOptions = {
    sourceType: commonJs ? "script" : "module",
    plugins,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowUndeclaredExports: true,
    allowNewTargetOutsideFunction: true,
    allowSuperOutsideMethod: true,
    errorRecovery: options.bundle === true,
    tokens: options.tokens === true,
  };
  try {
    const file = parse(source, parserOptions);
    return {
      ok: true,
      program: file.program as unknown as SyntaxNode,
      comments: (file.comments ?? []) as SourceSpan[],
      tokens: (file.tokens ?? []) as SourceSpan[],
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
