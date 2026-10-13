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

// How the Workflows page orders, hides and pages its cards. Pure functions
// over the catalog and the run summary so the page stays a thin view.

import type { Group } from "../lib/workflow_facets.ts";

/** What the page knows about a workflow's runs in the current time range. */
export interface RunStats {
  runs: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  lastStartedAt?: string;
}

/**
 * "auto" is the default: best match while a search query is typed, most
 * recent activity otherwise. The rest are explicit choices.
 */
export type WorkflowSort =
  | "auto"
  | "recent"
  | "name"
  | "runs"
  | "failures"
  | "time";

export const WORKFLOW_SORTS: readonly WorkflowSort[] = [
  "auto",
  "recent",
  "name",
  "runs",
  "failures",
  "time",
];

/** The order actually applied; "relevance" keeps the fuzzy ranking. */
export type EffectiveSort = Exclude<WorkflowSort, "auto"> | "relevance";

export function resolveSort(sort: WorkflowSort, query: string): EffectiveSort {
  if (sort !== "auto") return sort;
  return query.trim() ? "relevance" : "recent";
}

/** True when the workflow has no run in the time range. */
export function neverRan(stats: RunStats | undefined): boolean {
  return !stats || stats.runs === 0;
}

function lastStarted(stats: RunStats | undefined): number {
  if (!stats || stats.runs === 0 || !stats.lastStartedAt) {
    return Number.NEGATIVE_INFINITY;
  }
  const t = new Date(stats.lastStartedAt).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Orders workflows. Every order but "relevance" and "name" puts workflows
 * that never ran last (by name), and breaks ties by most recent run, then
 * name. "relevance" keeps the incoming (fuzzy-ranked) order.
 */
export function sortWorkflows<T extends { name: string }>(
  items: readonly T[],
  sort: EffectiveSort,
  statsOf: (item: T) => RunStats | undefined,
): T[] {
  if (sort === "relevance") return [...items];
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  if (sort === "name") return [...items].sort(byName);
  const metric = (s: RunStats | undefined): number => {
    if (!s) return 0;
    switch (sort) {
      case "runs":
        return s.runs;
      case "failures":
        return s.failed;
      case "time":
        return s.durationMs;
      default:
        return 0;
    }
  };
  return [...items].sort((a, b) => {
    const sa = statsOf(a);
    const sb = statsOf(b);
    const na = neverRan(sa);
    const nb = neverRan(sb);
    if (na !== nb) return na ? 1 : -1;
    return metric(sb) - metric(sa) ||
      lastStarted(sb) - lastStarted(sa) ||
      byName(a, b);
  });
}

/** Splits items into those that ran in the range and those that never did. */
export function partitionByActivity<T>(
  items: readonly T[],
  statsOf: (item: T) => RunStats | undefined,
): { ran: T[]; neverRan: T[] } {
  const ran: T[] = [];
  const idle: T[] = [];
  for (const item of items) (neverRan(statsOf(item)) ? idle : ran).push(item);
  return { ran, neverRan: idle };
}

/**
 * The first `limit` items across groups, in order, for progressive
 * rendering. Groups emptied by the limit are dropped; `total` counts every
 * item in every group (a workflow in two groups counts twice, as it renders
 * twice).
 */
export function takeAcrossGroups<T>(
  groups: readonly Group<T>[],
  limit: number,
): { groups: Group<T>[]; shown: number; total: number } {
  let remaining = Math.max(0, limit);
  let total = 0;
  const out: Group<T>[] = [];
  for (const g of groups) {
    total += g.items.length;
    if (remaining === 0) continue;
    const items = g.items.slice(0, remaining);
    remaining -= items.length;
    if (items.length > 0) out.push({ ...g, items });
  }
  return { groups: out, shown: limit - remaining, total };
}

export interface GroupAggregate {
  runs: number;
  failed: number;
  /** succeeded / (succeeded + failed), or null when nothing finished. */
  passRate: number | null;
}

export function aggregateRuns<T>(
  items: readonly T[],
  statsOf: (item: T) => RunStats | undefined,
): GroupAggregate {
  let runs = 0;
  let failed = 0;
  let succeeded = 0;
  for (const item of items) {
    const s = statsOf(item);
    if (!s) continue;
    runs += s.runs;
    failed += s.failed;
    succeeded += s.succeeded;
  }
  const finished = succeeded + failed;
  return { runs, failed, passRate: finished > 0 ? succeeded / finished : null };
}

/** "97%" with no misleading rounding to 100% while anything failed. */
export function formatPassRate(rate: number): string {
  const pct = rate * 100;
  if (rate < 1 && pct >= 99.5) return ">99%";
  if (rate > 0 && pct < 0.5) return "<1%";
  return `${Math.round(pct)}%`;
}
