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

// Keyboard and search behaviour for the themed Select, kept pure so it can
// be tested without a DOM.

import { fuzzyFilter } from "./fuzzy.ts";

export interface OptionLike {
  label: string;
  /** Secondary text, e.g. a count; also searched. */
  hint?: string;
  disabled?: boolean;
}

/** Keys that move the active option. */
export type NavKey =
  | "ArrowDown"
  | "ArrowUp"
  | "Home"
  | "End"
  | "PageDown"
  | "PageUp";

const NAV_KEYS: ReadonlySet<string> = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
]);

export function isNavKey(key: string): key is NavKey {
  return NAV_KEYS.has(key);
}

const PAGE = 8;

/**
 * The next active index for a navigation key, skipping disabled options
 * and stopping at the ends (no wrap, like a native select). Returns -1
 * when nothing is selectable.
 */
export function moveActive(
  options: readonly OptionLike[],
  current: number,
  key: NavKey,
): number {
  const enabled = options
    .map((o, i) => (o.disabled ? -1 : i))
    .filter((i) => i >= 0);
  if (enabled.length === 0) return -1;
  const first = enabled[0];
  const last = enabled[enabled.length - 1];
  if (current < 0) {
    return key === "ArrowUp" || key === "End" || key === "PageUp"
      ? last
      : first;
  }
  switch (key) {
    case "Home":
      return first;
    case "End":
      return last;
    case "ArrowDown":
      return enabled.find((i) => i > current) ?? last;
    case "ArrowUp":
      return [...enabled].reverse().find((i) => i < current) ?? first;
    case "PageDown": {
      const pos = enabled.findIndex((i) => i >= current);
      return enabled[Math.min(enabled.length - 1, Math.max(pos, 0) + PAGE)];
    }
    case "PageUp": {
      const pos = enabled.findIndex((i) => i >= current);
      return enabled[Math.max(0, (pos < 0 ? enabled.length : pos) - PAGE)];
    }
  }
}

/**
 * Type-to-select: the first enabled option after `current` whose label
 * starts with `buffer`, wrapping around. Repeating one character cycles
 * through options starting with it, as native selects do. -1 if none.
 */
export function typeaheadMatch(
  options: readonly OptionLike[],
  buffer: string,
  current: number,
): number {
  if (!buffer) return -1;
  const needle = buffer.toLowerCase();
  const repeated = needle.length > 1 &&
    [...needle].every((c) => c === needle[0]);
  const search = repeated ? needle[0] : needle;
  // A fresh multi-character buffer may match the current option itself.
  const start = repeated || needle.length === 1 ? current + 1 : current;
  const n = options.length;
  for (let k = 0; k < n; k++) {
    const i = ((start < 0 ? 0 : start) + k) % n;
    const o = options[i];
    if (!o.disabled && o.label.toLowerCase().startsWith(search)) return i;
  }
  return -1;
}

/** Options matching a search query (fuzzy, best first); all when empty. */
export function filterOptions<T extends OptionLike>(
  options: readonly T[],
  query: string,
): T[] {
  return fuzzyFilter(options, query, (o) => [o.label, o.hint ?? ""]);
}

/** Show a search box once a list is long enough to need one. */
export const SEARCH_THRESHOLD = 10;
