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

// The guided search: what the search box suggests as the user types. An
// empty box offers the facets you can filter by; "prefix:" offers that
// facet's values; anything else searches names and also offers matching
// facets and values ("git" → webhook /hooks/github-push). Pure, so the
// suggestion rules are tested without a DOM.

import { fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";

export interface FacetValue {
  value: string;
  label: string;
  /** Muted right-aligned text, e.g. a count. */
  hint?: string;
  /** Longer explanation shown in the suggestion list, never on chips. */
  detail?: string;
}

export interface FacetDef {
  /** What the user types before the colon: "prefix", "webhook". */
  key: string;
  /** Shown on chips and headings: "Prefix". */
  label: string;
  /** One line telling the user what this narrows by. */
  description: string;
  values: readonly FacetValue[];
}

export type Suggestion =
  | { kind: "facet"; facet: FacetDef }
  | { kind: "value"; facet: FacetDef; value: FacetValue }
  | { kind: "text"; text: string };

/** "prefix:dep" → the prefix facet and "dep"; null when not `key:` form. */
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

const MAX_VALUES = 60;
const MAX_CROSS_VALUES = 6;

/**
 * Suggestions for the current input. Facets that already have a value
 * (`applied`) aren't offered again as a facet, but their values are, so
 * a chip can be swapped by picking another value.
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
  out.push(...values.slice(0, MAX_CROSS_VALUES).map((v) => v.s));
  return out;
}
