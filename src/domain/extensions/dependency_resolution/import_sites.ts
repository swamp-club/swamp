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
 * The import sites a module writes: the one place push, quality, fmt and the
 * loader read them (swamp-club#3969). Sites come from the shared scorer's
 * scanner (`@swamp-club/extension-scoring/source`), so push reads imports as
 * the registry does: comments and template literals blanked, string
 * literals read as tokens.
 *
 * Two readings older than that scanner stay here unchanged, so this module
 * changes no behaviour: the `from`-only reading the package.json trigger and
 * the loader's expected-failure check use, and the import-statement reading
 * of the bundler's zod scan. swamp-club#3983 replaces the scanner with a
 * syntax-tree read and folds them in.
 */

import {
  importedSpecifiersAt,
  stripSourceComments,
} from "@swamp-club/extension-scoring/source";
import {
  type AstNode,
  isNode,
  LineIndex,
  parseExtensionSource,
} from "../extension_source_ast.ts";
import type { SpecifierSpan } from "../extension_source_graph.ts";
import { isBareSpecifier } from "./specifier.ts";

/** An import specifier as the source writes it, and where. */
export interface ImportSite {
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
export function scanImportSites(source: string): ImportSite[] {
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
 * The offsets, with their values, of the string literals Babel parses as
 * the module specifier of an import: a static import or `export ... from`, a dynamic `import()`
 * and a `typeof import()` type. Undefined when `source` does not parse. The
 * token scanner cannot tell a regex literal from a string, so only a span
 * the parser confirms is rewritten (swamp-club#3637).
 */
export function parsedImportOffsets(
  source: string,
  jsx: boolean,
): Map<number, string> | undefined {
  const program = parseExtensionSource(source, { jsx });
  if (!program) return undefined;
  const offsets = new Map<number, string>();
  const add = (node: unknown) => {
    if (
      isNode(node) && node.type === "StringLiteral" &&
      typeof node.start === "number" && typeof node.value === "string"
    ) {
      offsets.set(node.start, node.value);
    }
  };
  // Explicit stack: extension source can nest deeply.
  const stack: AstNode[] = [program];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
      case "ImportExpression":
        add(node.source);
        break;
      case "CallExpression": {
        const callee = node.callee;
        const args = node.arguments;
        if (isNode(callee) && callee.type === "Import" && Array.isArray(args)) {
          add(args[0]);
        }
        break;
      }
      case "TSImportType": {
        const argument = node.argument;
        add(
          isNode(argument) && argument.type === "TSLiteralType"
            ? argument.literal
            : argument,
        );
        break;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item);
      } else if (isNode(value)) {
        stack.push(value);
      }
    }
  }
  return offsets;
}

// An `import ... from` or `export ... from` statement's specifier; a
// side-effect or dynamic import is not one.
const FROM_SPECIFIER_RE =
  /(?:import|export)\s+[^;()]*?from\s+["']([^"']+)["']/g;

/**
 * The bare names `source` imports with `import ... from` or
 * `export ... from`, unique, read with comments and template literals
 * blanked. A side-effect or dynamic import of a bare name is not read: the
 * package.json trigger and the loader's expected-failure check have always
 * read only these (swamp-club#3983 changes that).
 */
export function bareFromImports(source: string): string[] {
  const bare = new Set<string>();
  for (const match of stripSourceComments(source).matchAll(FROM_SPECIFIER_RE)) {
    if (isBareSpecifier(match[1])) bare.add(match[1]);
  }
  return [...bare];
}

// A static, side-effect or literal dynamic import, or a re-export: the
// specifier each import or export statement names.
const IMPORT_STATEMENT_SPECIFIER_RE =
  /(?:\bfrom|\bimport)\s*\(?\s*["']([^"'\n]+)["']/g;

/**
 * The specifier each import or export statement in `source` names, read as
 * text with comments and template literals blanked: the bundler's zod scan
 * reads modules this way (swamp-club#3983 moves it onto
 * {@link scanImportSites}).
 */
export function importStatementSpecifiers(source: string): string[] {
  return [
    ...stripSourceComments(source).matchAll(IMPORT_STATEMENT_SPECIFIER_RE),
  ].map((match) => match[1]);
}
