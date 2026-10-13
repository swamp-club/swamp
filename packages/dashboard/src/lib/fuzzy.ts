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

// Fuzzy matching for the dashboard's search boxes. Every whitespace-
// separated term of the query must appear in the text as a subsequence;
// matches at word starts and runs of consecutive characters score higher,
// so "dep api" ranks "deploy-api" above "data-export-pipeline-api".

export interface FuzzyMatch {
  score: number;
  /** Indices into the text of every matched character, ascending. */
  indices: number[];
}

const BOUNDARY = /[\s\-_/.:@]/;

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (BOUNDARY.test(prev)) return true;
  // camelCase boundary
  return prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase();
}

function matchTerm(
  text: string,
  lower: string,
  term: string,
): FuzzyMatch | null {
  // Greedy left-to-right, then a second pass anchored at each word start
  // that begins with the term's first character; keep the best score.
  let best: FuzzyMatch | null = null;
  const starts: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === term[0]) starts.push(i);
  }
  for (const start of starts) {
    const indices: number[] = [];
    let ti = 0;
    for (let i = start; i < lower.length && ti < term.length; i++) {
      if (lower[i] === term[ti]) {
        indices.push(i);
        ti++;
      }
    }
    if (ti < term.length) break; // later starts can only match less
    let score = 0;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      score += 1;
      if (isWordStart(text, i)) score += 8;
      if (k > 0 && indices[k - 1] === i - 1) score += 5;
      else if (k > 0) score -= Math.min(i - indices[k - 1] - 1, 5);
    }
    if (indices[0] === 0) score += 6;
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

/**
 * Matches `query` against `text`. Returns null when any term is missing;
 * an empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  let score = 0;
  const all = new Set<number>();
  for (const term of terms) {
    const m = matchTerm(text, lower, term);
    if (!m) return null;
    score += m.score;
    for (const i of m.indices) all.add(i);
  }
  // Shorter texts win ties: "api" should prefer "deploy-api" over a longer
  // name with the same matches.
  score -= text.length / 100;
  return { score, indices: [...all].sort((a, b) => a - b) };
}

/**
 * Filters and ranks `items` by the best match across the strings `keys`
 * returns for each. Order is preserved for an empty query.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  keys: (item: T) => readonly string[],
): T[] {
  if (!query.trim()) return [...items];
  const scored: Array<{ item: T; score: number; order: number }> = [];
  items.forEach((item, order) => {
    let best: number | null = null;
    for (const key of keys(item)) {
      const m = fuzzyMatch(query, key);
      if (m && (best === null || m.score > best)) best = m.score;
    }
    if (best !== null) scored.push({ item, score: best, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.item);
}
