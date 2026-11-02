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

import { importedSpecifiersAt } from "@swamp-club/extension-scoring/source";
import { LineIndex } from "../extension_source_ast.ts";
import type { SpecifierSpan } from "../extension_source_graph.ts";

export interface ImportSite {
  specifier: string;
  span: SpecifierSpan;
  offset: number;
}

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
