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

import { fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";

export interface FacetValue {
  value: string;
  label: string;
  hint?: string;
  detail?: string;
}

export interface FacetDef {
  key: string;
  label: string;
  description: string;
  values: readonly FacetValue[];
}

export type Suggestion =
  | { kind: "facet"; facet: FacetDef }
  | { kind: "value"; facet: FacetDef; value: FacetValue }
  | { kind: "text"; text: string };

export function parseFacetInput(
  input: string,
  facets: readonly FacetDef[],
): { facet: FacetDef; partial: string } | null {
  const m = /^\s*([a-z][\w-]*)\s*:\s*(.*)$/i.exec(input);
  if (!m) return null;
  const key = m[1].toLowerCase();
  const facet = facets.find((f) =>
    f.key.toLowerCase() === key || f.label.toLowerCase() === key
  );
  return facet ? { facet, partial: m[2] } : null;
}

/**
 * after an outside query change (Clear filters, Back/Forward) the box shows the
 * query, unless it holds an unfinished `key:`
 */
export function draftForQuery(
  draft: string,
  query: string,
  facets: readonly FacetDef[],
): string {
  return parseFacetInput(draft, facets) === null ? query : draft;
}

const MAX_VALUES = 60;
const MAX_CROSS_VALUES = 6;

/**
 * facets that already have a value are not offered again, but their values are,
 * so a chip can be swapped by picking another value
 */
export function suggestionsFor(
  input: string,
  facets: readonly FacetDef[],
  applied: ReadonlySet<string> = new Set(),
): Suggestion[] {
  const usable = facets.filter((f) => f.values.length > 0);
  const text = input.trim();
  if (!text) {
    return usable
      .filter((f) => !applied.has(f.key))
      .map((facet) => ({ kind: "facet", facet }));
  }
  const parsed = parseFacetInput(text, usable);
  if (parsed) {
    return fuzzyFilter(parsed.facet.values, parsed.partial, (v) => [
      v.label,
      v.value,
    ])
      .slice(0, MAX_VALUES)
      .map((value) => ({ kind: "value", facet: parsed.facet, value }));
  }
  const out: Suggestion[] = [{ kind: "text", text }];
  for (const facet of usable) {
    if (applied.has(facet.key)) continue;
    if (fuzzyMatch(text, facet.key) || fuzzyMatch(text, facet.label)) {
      out.push({ kind: "facet", facet });
    }
  }
  const values: Array<{ s: Suggestion; score: number }> = [];
  for (const facet of usable) {
    for (const value of facet.values) {
      const m = fuzzyMatch(text, value.label);
      if (m && m.score > 0) {
        values.push({ s: { kind: "value", facet, value }, score: m.score });
      }
    }
  }
  values.sort((a, b) => b.score - a.score);
  for (const v of values.slice(0, MAX_CROSS_VALUES)) out.push(v.s);
  return out;
}
