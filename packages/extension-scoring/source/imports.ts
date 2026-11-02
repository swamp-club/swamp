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
 * the registry runs this on archives it did not author, so a module that does
 * not parse yields no specifiers and is never read as text
 */

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

export interface ImportedSpecifierAt {
  specifier: string;
  start: number;
  end: number;
}

function isNode(value: unknown): value is SyntaxNode {
  return typeof value === "object" && value !== null &&
    typeof (value as { type?: unknown }).type === "string";
}

/**
 * text in a comment, string, template or regex literal is never an import, and
 * neither is a dynamic import of anything but a string literal
 */
export function importedSpecifiersIn(
  program: SyntaxNode,
): ImportedSpecifierAt[] {
  const found: ImportedSpecifierAt[] = [];
  const add = (node: unknown) => {
    if (
      isNode(node) && node.type === "StringLiteral" &&
      typeof node.value === "string" && typeof node.start === "number" &&
      typeof node.end === "number"
    ) {
      found.push({ specifier: node.value, start: node.start, end: node.end });
    }
  };
  // Explicit stack: extension source can nest deeply.
  const stack: SyntaxNode[] = [program];
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
  return found.sort((a, b) => a.start - b.start);
}

export function importedSpecifiersAt(
  source: string,
  options: Pick<ParseModuleOptions, "path"> = {},
): ImportedSpecifierAt[] | null {
  const parsed = parseExtensionModule(source, options);
  return parsed.ok ? importedSpecifiersIn(parsed.program) : null;
}

export function importedSpecifiers(
  source: string,
  options: Pick<ParseModuleOptions, "path"> = {},
): string[] {
  return (importedSpecifiersAt(source, options) ?? []).map((s) => s.specifier);
}
