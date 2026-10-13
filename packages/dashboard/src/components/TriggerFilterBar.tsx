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
import { buildRowFacets, type RowFacetSpec } from "../lib/row_facets.ts";

interface TriggerFilterBarProps {
  query: string;
  onQuery: (query: string) => void;
  placeholder: string;
  facets: readonly SearchFacet[];
  shown: number;
  total: number;
  noun: string;
  onClear: () => void;
  children?: ReactNode;
}

/** The trigger pages' guided search, the same box as the workflow pages. */
export function TriggerFilterBar(
  {
    query,
    onQuery,
    placeholder,
    facets,
    shown,
    total,
    noun,
    onClear,
    children,
  }: TriggerFilterBarProps,
) {
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

/**
 * Search facets for a table's rows, wired to selections held elsewhere
 * (usually `useFacetParams`).
 */
export function rowSearchFacets<R>(
  rows: readonly R[],
  specs: readonly RowFacetSpec<R>[],
  selected: Readonly<Record<string, readonly string[]>>,
  select: (key: string, values: readonly string[]) => void,
): SearchFacet[] {
  return buildRowFacets(rows, specs).map((f) => ({
    ...f,
    selected: selected[f.key] ?? [],
    onSelect: (values: readonly string[]) => select(f.key, values),
  }));
}
