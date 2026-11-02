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

// Facets computed from a table's own rows (a webhook's workflow, its last
// run's status…), for pages whose filters aren't the shared workflow
// facets. Values carry how many rows have them; selections combine with
// AND, like the chips in the search box.

import { formatCount } from "./format.ts";
import type { FacetDef } from "./search_facets.ts";

export interface RowFacetSpec<R> {
  key: string;
  label: string;
  description: string;
  /** The row's value for this facet; null rows never match a selection. */
  valueOf: (row: R) => string | null;
  /** Display label for a value (defaults to the value). */
  labelOf?: (value: string) => string;
  /** Fixed value order (e.g. statuses); others sort by label after. */
  order?: readonly string[];
}

/**
 * One facet per spec with every value present in `rows` and its count.
 * A facet whose rows all share one value (or none) can't narrow anything,
 * so it's left without values and the search box doesn't offer it.
 */
export function buildRowFacets<R>(
  rows: readonly R[],
  specs: readonly RowFacetSpec<R>[],
): FacetDef[] {
  return specs.map((spec) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const v = spec.valueOf(row);
      if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const label = spec.labelOf ?? ((v: string) => v);
    const rank = (v: string) => {
      const i = spec.order?.indexOf(v) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const values = counts.size < 2 ? [] : [...counts.entries()]
      .sort((a, b) =>
        rank(a[0]) - rank(b[0]) || label(a[0]).localeCompare(label(b[0]))
      )
      .map(([value, n]) => ({
        value,
        label: label(value),
        hint: formatCount(n),
      }));
    return {
      key: spec.key,
      label: spec.label,
      description: spec.description,
      values,
    };
  });
}

/**
 * Rows matching the selections: any selected value of a facet (OR), for
 * every facet with a selection (AND).
 */
export function applyRowFacets<R>(
  rows: readonly R[],
  specs: readonly RowFacetSpec<R>[],
  selected: Readonly<Record<string, readonly string[]>>,
): R[] {
  const active = specs.filter((s) => (selected[s.key]?.length ?? 0) > 0);
  if (active.length === 0) return [...rows];
  return rows.filter((row) =>
    active.every((s) => {
      const v = s.valueOf(row);
      return v !== null && selected[s.key].includes(v);
    })
  );
}
