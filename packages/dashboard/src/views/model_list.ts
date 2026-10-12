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

import { fuzzyFilter } from "../lib/fuzzy.ts";
import { formatCount } from "../lib/format.ts";
import { workflowPrefix } from "../lib/workflow_facets.ts";
import type { ModelUsage } from "./model_executions.ts";

// Filtering and ordering for the Models page. Search is fuzzy over the
// name and the type; the type and prefix selects narrow exactly.

/** A `model.search` row; `methods` only when serve includes it. */
export interface ModelSummary {
  id: string;
  name: string;
  type: string;
  methods?: string[];
}

export interface ModelFilter {
  query: string;
  /** Exact model type. */
  type: string | null;
  /** Name prefix, as `workflowPrefix` derives it. */
  prefix: string | null;
}

export type ModelSort = "name" | "recent" | "busy";

/** Models matching `filter`, ranked by match when there is a query. */
export function filterModels(
  models: readonly ModelSummary[],
  filter: ModelFilter,
): ModelSummary[] {
  const narrowed = models.filter((m) =>
    (filter.type === null || m.type === filter.type) &&
    (filter.prefix === null || workflowPrefix(m.name) === filter.prefix)
  );
  return fuzzyFilter(narrowed, filter.query, (m) => [m.name, m.type]);
}

/**
 * Orders models. "relevance" keeps the incoming (fuzzy-ranked) order;
 * "recent" and "busy" put used models first, then fall back to name.
 */
export function sortModels(
  models: readonly ModelSummary[],
  sort: ModelSort | "relevance",
  usageOf: (m: ModelSummary) => ModelUsage | undefined,
): ModelSummary[] {
  if (sort === "relevance") return [...models];
  const byName = (a: ModelSummary, b: ModelSummary) =>
    a.name.localeCompare(b.name);
  if (sort === "name") return [...models].sort(byName);
  const key = (m: ModelSummary): number => {
    const u = usageOf(m);
    if (!u) return -Infinity;
    if (sort === "busy") return u.executions;
    return u.lastStartedAt ? Date.parse(u.lastStartedAt) : -Infinity;
  };
  return [...models].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return kb > ka ? 1 : -1;
    return byName(a, b);
  });
}

export interface CountedOption {
  value: string;
  label: string;
}

function counted(values: Iterable<string>): CountedOption[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, n]) => ({ value, label: `${value} (${formatCount(n)})` }));
}

/** One option per model type, with how many models use it. */
export function modelTypeOptions(
  models: readonly ModelSummary[],
): CountedOption[] {
  return counted(models.map((m) => m.type));
}

/** One option per name prefix shared by the models. */
export function modelPrefixOptions(
  models: readonly ModelSummary[],
): CountedOption[] {
  const prefixes: string[] = [];
  for (const m of models) {
    const p = workflowPrefix(m.name);
    if (p) prefixes.push(p);
  }
  return counted(prefixes);
}

/**
 * A count from a capped page of executions: "1,234", or "1,234+" when the
 * page hit its cap, so the real number may be higher.
 */
export function partialCount(n: number, partial: boolean): string {
  return `${formatCount(n)}${partial ? "+" : ""}`;
}

/** "3 runs", "1 run", or "3+ runs" from a capped page. */
export function partialPlural(
  n: number,
  singular: string,
  partial: boolean,
  plural = `${singular}s`,
): string {
  return `${partialCount(n, partial)} ${
    n === 1 && !partial ? singular : plural
  }`;
}
