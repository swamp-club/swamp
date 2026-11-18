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
 * Reading the import specifiers a TypeScript or JavaScript module writes,
 * from its syntax tree. The registry runs this on archives it did not
 * author, so a module that does not parse yields no specifiers here and is
 * never read as text.
 *
 * @module
 */

import { statementsWithNestedImports } from "./import_scan.ts";
import {
  parseExtensionModule,
  type ParseModuleOptions,
  type SyntaxNode,
} from "./parse.ts";

export {
  type ParsedModule,
  parseExtensionModule,
  type ParseModuleOptions,
  parserPluginsFor,
  type SourceSpan,
  type SyntaxNode,
  type UnparsedModule,
} from "./parse.ts";

/** A specifier in import position, by UTF-16 offsets of its quotes. */
export interface ImportedSpecifierAt {
  specifier: string;
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
}

function isNode(value: unknown): value is SyntaxNode {
  return typeof value === "object" && value !== null &&
    typeof (value as { type?: unknown }).type === "string";
}

/**
 * The module specifiers `program` imports, in source order: static imports,
 * side-effect imports, `export ... from`, `export * from`, dynamic
 * `import()` and `typeof import()` types, each written as a string literal.
 * Text in a comment, string, template or regex literal is never one, and
 * neither is a dynamic import of anything but a string literal.
 */
export function importedSpecifiersIn(
  program: SyntaxNode,
): ImportedSpecifierAt[] {
  const found: ImportedSpecifierAt[] = [];
  collectSpecifiers([program], found);
  return found.sort((a, b) => a.start - b.start);
}

// The top-level declarations that carry a source, read without walking below.
const DECLARATIONS_WITH_SOURCE = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
]);

/**
 * {@link importedSpecifiersIn}, walking below the top only the statements
 * {@link statementsWithNestedImports} picks.
 */
function importedSpecifiersInSource(
  program: SyntaxNode,
  source: string,
): ImportedSpecifierAt[] {
  const body = program.body;
  if (!Array.isArray(body) || !body.every(isNode)) {
    return importedSpecifiersIn(program);
  }
  const deep = statementsWithNestedImports(body, source);
  const found: ImportedSpecifierAt[] = [];
  const roots: SyntaxNode[] = [];
  body.forEach((statement, index) => {
    if (deep.has(index)) roots.push(statement);
    else if (DECLARATIONS_WITH_SOURCE.has(statement.type)) {
      addSpecifier(found, statement.source);
    }
  });
  collectSpecifiers(roots, found);
  return found.sort((a, b) => a.start - b.start);
}

function addSpecifier(found: ImportedSpecifierAt[], node: unknown): void {
  if (
    isNode(node) && node.type === "StringLiteral" &&
    typeof node.value === "string" && typeof node.start === "number" &&
    typeof node.end === "number"
  ) {
    found.push({ specifier: node.value, start: node.start, end: node.end });
  }
}

function collectSpecifiers(
  roots: readonly SyntaxNode[],
  found: ImportedSpecifierAt[],
): void {
  const add = (node: unknown) => addSpecifier(found, node);
  // Explicit stack: extension source can nest deeply.
  const stack: SyntaxNode[] = [...roots];
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
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "extra") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item);
      } else if (isNode(value)) {
        stack.push(value);
      }
    }
  }
}

/**
 * The specifiers in import position in `source`, with their offsets (see
 * {@link importedSpecifiersIn}), or null when the module does not parse.
 * `options.path` picks TypeScript, JavaScript or JSX.
 */
export function importedSpecifiersAt(
  source: string,
  options: Pick<ParseModuleOptions, "path"> = {},
): ImportedSpecifierAt[] | null {
  const parsed = parseExtensionModule(source, options);
  return parsed.ok ? importedSpecifiersInSource(parsed.program, source) : null;
}

/**
 * The specifiers {@link importedSpecifiersAt} finds, in source order; none
 * for a module that does not parse.
 */
export function importedSpecifiers(
  source: string,
  options: Pick<ParseModuleOptions, "path"> = {},
): string[] {
  return (importedSpecifiersAt(source, options) ?? []).map((s) => s.specifier);
}
