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

// How the dashboard slices workflows: by name prefix, by what triggers
// them (a schedule, a webhook, or only manual/API runs) and by webhook
// route. Workflows, Executions and Approvals share these so a filter means
// the same thing on every page.

import { fuzzyFilter } from "./fuzzy.ts";

export type TriggerKind = "schedule" | "webhook" | "manual";

export interface WorkflowRef {
  name: string;
  id?: string;
  /** The schedule the workflow file declares. */
  trigger?: { schedule?: string };
}

export interface TriggerSources {
  /** Workflows with an effective schedule, by name (from health). */
  scheduled?: ReadonlyArray<{ workflowName?: string; workflowId?: string }>;
  /** Webhook routes; `workflow` is the configured id or name. */
  webhooks?: ReadonlyArray<{ route: string; workflow: string }>;
}

export interface WorkflowFacets {
  prefix: string | null;
  scheduled: boolean;
  webhooks: string[];
  kinds: TriggerKind[];
}

/**
 * The group a name belongs to: the scope of a scoped name ("@acme/x" →
 * "@acme"), else the text before the first "-", "_", "." or "/"
 * ("deploy-api" → "deploy"). Names with no separator have no prefix.
 */
export function workflowPrefix(name: string): string | null {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    return slash > 1 ? name.slice(0, slash) : null;
  }
  const match = /^([^-_./]+)[-_./]./.exec(name);
  return match ? match[1] : null;
}

/** Builds a lookup from workflow to its facets. */
export function facetIndex(
  sources: TriggerSources,
): (workflow: WorkflowRef) => WorkflowFacets {
  const scheduledKeys = new Set<string>();
  for (const s of sources.scheduled ?? []) {
    if (s.workflowName) scheduledKeys.add(s.workflowName);
    if (s.workflowId) scheduledKeys.add(s.workflowId);
  }
  const routesByKey = new Map<string, string[]>();
  for (const w of sources.webhooks ?? []) {
    const routes = routesByKey.get(w.workflow) ?? [];
    routes.push(w.route);
    routesByKey.set(w.workflow, routes);
  }
  return (workflow) => {
    const scheduled = Boolean(workflow.trigger?.schedule) ||
      scheduledKeys.has(workflow.name) ||
      (workflow.id !== undefined && scheduledKeys.has(workflow.id));
    const webhooks = [
      ...(routesByKey.get(workflow.name) ?? []),
      ...(workflow.id !== undefined ? routesByKey.get(workflow.id) ?? [] : []),
    ].sort();
    const kinds: TriggerKind[] = [];
    if (scheduled) kinds.push("schedule");
    if (webhooks.length > 0) kinds.push("webhook");
    if (kinds.length === 0) kinds.push("manual");
    return {
      prefix: workflowPrefix(workflow.name),
      scheduled,
      webhooks,
      kinds,
    };
  };
}

export type TriggerFilter = "all" | TriggerKind;

/**
 * What the workflow pages filter by. Values within one facet combine with
 * OR (prefix deploy or sync); facets combine with AND. An empty list
 * doesn't narrow.
 */
export interface WorkflowFilter {
  query: string;
  prefixes: readonly string[];
  triggers: readonly TriggerKind[];
  webhooks: readonly string[];
}

export const EMPTY_FILTER: WorkflowFilter = {
  query: "",
  prefixes: [],
  triggers: [],
  webhooks: [],
};

export function isFilterActive(filter: WorkflowFilter): boolean {
  return filter.query.trim() !== "" || filter.prefixes.length > 0 ||
    filter.triggers.length > 0 || filter.webhooks.length > 0;
}

/** True when the facets pass every facet filter (the query is separate). */
export function matchesFacets(
  facets: WorkflowFacets,
  filter: WorkflowFilter,
): boolean {
  if (
    filter.prefixes.length > 0 &&
    (facets.prefix === null || !filter.prefixes.includes(facets.prefix))
  ) return false;
  if (
    filter.triggers.length > 0 &&
    !filter.triggers.some((t) => facets.kinds.includes(t))
  ) return false;
  if (
    filter.webhooks.length > 0 &&
    !filter.webhooks.some((w) => facets.webhooks.includes(w))
  ) return false;
  return true;
}

/**
 * Applies a filter: facet filters first, then the fuzzy query over the
 * name (and webhook routes), ranked by match quality when a query is set.
 */
export function applyWorkflowFilter<T>(
  items: readonly T[],
  filter: WorkflowFilter,
  workflowOf: (item: T) => WorkflowRef,
  facetsOf: (workflow: WorkflowRef) => WorkflowFacets,
): T[] {
  const faceted = items.filter((item) =>
    matchesFacets(facetsOf(workflowOf(item)), filter)
  );
  return fuzzyFilter(faceted, filter.query, (item) => {
    const wf = workflowOf(item);
    return [wf.name, ...facetsOf(wf).webhooks];
  });
}

export type GroupBy = "none" | "prefix" | "trigger" | "webhook";

export interface Group<T> {
  key: string;
  label: string;
  items: T[];
}

const TRIGGER_LABELS: Record<TriggerKind, string> = {
  schedule: "Scheduled",
  webhook: "Webhook",
  manual: "Manual / API only",
};

/**
 * Groups items, keeping each group's items in their incoming order. A
 * workflow with several webhooks (or both a schedule and a webhook)
 * appears in each of its groups; ungrouped items land in a trailing
 * "Other" / "No webhook" group.
 */
export function groupWorkflows<T>(
  items: readonly T[],
  by: GroupBy,
  workflowOf: (item: T) => WorkflowRef,
  facetsOf: (workflow: WorkflowRef) => WorkflowFacets,
): Group<T>[] {
  if (by === "none") return [{ key: "all", label: "All", items: [...items] }];
  const groups = new Map<string, Group<T>>();
  const add = (key: string, label: string, item: T) => {
    const g = groups.get(key) ?? { key, label, items: [] };
    g.items.push(item);
    groups.set(key, g);
  };
  for (const item of items) {
    const facets = facetsOf(workflowOf(item));
    if (by === "prefix") {
      if (facets.prefix) add(`p:${facets.prefix}`, facets.prefix, item);
      else add("~other", "Other", item);
    } else if (by === "trigger") {
      for (const kind of facets.kinds) {
        add(`t:${kind}`, TRIGGER_LABELS[kind], item);
      }
    } else {
      if (facets.webhooks.length === 0) add("~none", "No webhook", item);
      for (const route of facets.webhooks) add(`w:${route}`, route, item);
    }
  }
  const order = (key: string) =>
    by === "trigger"
      ? ["t:schedule", "t:webhook", "t:manual"].indexOf(key)
      : key.startsWith("~")
      ? 1
      : 0;
  return [...groups.values()].sort((a, b) =>
    order(a.key) - order(b.key) || a.label.localeCompare(b.label)
  );
}

/** Distinct prefixes with how many items carry each, most common first. */
export function prefixOptions(
  names: readonly string[],
): Array<{ prefix: string; count: number }> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const p = workflowPrefix(name);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}
