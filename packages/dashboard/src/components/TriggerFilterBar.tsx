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

/** @jsxRuntime automatic */
/** @jsxImportSource react */

import type { ReactNode } from "react";
import { SearchBar, type SearchFacet } from "./SearchBar.tsx";
import { formatCount } from "../lib/format.ts";

interface TriggerFilterBarProps {
  query: string;
  onQuery: (query: string) => void;
  placeholder: string;
  /** Prefix choices; the select hides when empty. */
  prefixes?: ReadonlyArray<{ prefix: string; count: number }>;
  prefix?: string | null;
  onPrefix?: (prefix: string | null) => void;
  /** A segmented control (e.g. All / Active / Paused). */
  segments?: ReadonlyArray<{ value: string; label: string }>;
  segment?: string;
  onSegment?: (value: string) => void;
  shown: number;
  total: number;
  noun: string;
  onClear: () => void;
  children?: ReactNode;
}

/**
 * The trigger pages' guided search: names plus a state and prefix facet,
 * through the same search box as the workflow pages.
 */
export function TriggerFilterBar(
  {
    query,
    onQuery,
    placeholder,
    prefixes = [],
    prefix = null,
    onPrefix,
    segments,
    segment,
    onSegment,
    shown,
    total,
    noun,
    onClear,
    children,
  }: TriggerFilterBarProps,
) {
  const facets: SearchFacet[] = [];
  if (segments && onSegment) {
    const [all, ...rest] = segments;
    facets.push({
      key: "state",
      label: "State",
      description: `Only ${noun} in a given state`,
      values: rest.map((s) => ({ value: s.value, label: s.label })),
      selected: segment && segment !== all.value ? segment : null,
      onSelect: (v) => onSegment(v ?? all.value),
    });
  }
  if (onPrefix && prefixes.length > 0) {
    facets.push({
      key: "prefix",
      label: "Prefix",
      description: "Workflows whose name starts with a prefix",
      values: prefixes.map((p) => ({
        value: p.prefix,
        label: p.prefix,
        hint: formatCount(p.count),
      })),
      selected: prefix,
      onSelect: onPrefix,
    });
  }
  return (
    <SearchBar
      query={query}
      onQuery={onQuery}
      facets={facets}
      placeholder={placeholder}
      shown={shown}
      total={total}
      noun={noun}
      onClear={onClear}
      trailing={children}
    />
  );
}
