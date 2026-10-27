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
 * import scan (`@swamp-club/extension-scoring/source`), which reads the
 * module's syntax tree, so push reads imports as the registry does
 * (swamp-club#3983).
 */

import { importedSpecifiersAt } from "@swamp-club/extension-scoring/source";
import { LineIndex } from "../extension_source_ast.ts";
import type { SpecifierSpan } from "../extension_source_graph.ts";

/** An import specifier as the source writes it, and where. */
export interface ImportSite {
  specifier: string;
  /** Quotes included; zero-based line, code-point columns. */
  span: SpecifierSpan;
  /** UTF-16 offset of the opening quote in the source. */
  offset: number;
}

/**
 * Every module specifier `source` imports (static, side-effect and dynamic
 * imports, re-exports and `typeof import()` types), with its span, read the
 * way the dependency audit reads them. Null when the module does not parse.
 * `path` picks TypeScript, JavaScript or JSX; without one the module is read
 * as TypeScript.
 */
export function scanImportSites(
  source: string,
  path?: string,
): ImportSite[] | null {
  const sites = importedSpecifiersAt(source, { path });
  if (!sites) return null;
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
  return sites.map((s) => ({
    specifier: s.specifier,
    span: { start: at(s.start), end: at(s.end) },
    offset: s.start,
  }));
}
