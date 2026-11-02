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

import { useMemo } from "react";

import { SearchBar, type SearchFacet } from "./SearchBar.tsx";
import { ViewMenu, type ViewSection } from "./ViewMenu.tsx";
import {
  asString,
  useQueryList,
  useQueryState,
} from "../client/useQueryState.ts";
import {
  EMPTY_FILTER,
  type TriggerKind,
  type WorkflowFilter,
} from "../lib/workflow_facets.ts";
import { formatCount } from "../lib/format.ts";

const TRIGGERS: readonly TriggerKind[] = ["schedule", "webhook", "manual"];

const TRIGGER_LABELS: Record<TriggerKind, string> = {
  schedule: "Cron",
  webhook: "Webhook",
  manual: "Manual",
};

const TRIGGER_DESCRIPTIONS: Record<TriggerKind, string> = {
  schedule: "Runs on a cron schedule",
  webhook: "Started by a webhook",
  manual: "Only run by hand or the API",
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The shared workflow filter, mirrored to `?q=` and repeated
 * `?prefix=&trigger=&webhook=` params (several values per facet).
 */
export function useWorkflowFilter(): [
  WorkflowFilter,
  (next: WorkflowFilter) => void,
] {
  const [query, setQuery] = useQueryState("q", "", asString);
  const [prefixes, setPrefixes] = useQueryList("prefix");
  const [rawTriggers, setTriggers] = useQueryList("trigger");
  const [webhooks, setWebhooks] = useQueryList("webhook");
  const triggers = useMemo(
    () =>
      rawTriggers.filter((t): t is TriggerKind =>
        (TRIGGERS as readonly string[]).includes(t)
      ),
    [rawTriggers],
  );
  const filter = useMemo(
    () => ({ query, prefixes, triggers, webhooks }),
    [query, prefixes, triggers, webhooks],
  );
  const set = (next: WorkflowFilter) => {
    if (next.query !== query) setQuery(next.query);
    if (!sameList(next.prefixes, prefixes)) setPrefixes(next.prefixes);
    if (!sameList(next.triggers, triggers)) setTriggers(next.triggers);
    if (!sameList(next.webhooks, webhooks)) setWebhooks(next.webhooks);
  };
  return [filter, set];
}

export type { SelectOption } from "./Select.tsx";

interface FilterBarProps {
  filter: WorkflowFilter;
  onChange: (next: WorkflowFilter) => void;
  prefixes: ReadonlyArray<{ prefix: string; count: number }>;
  webhooks: readonly string[];
  placeholder?: string;
  /** "12 of 134 workflows" when filtering. */
  shown?: number;
  total?: number;
  noun?: string;
  /** Page-specific facets after prefix / trigger / webhook (e.g. status). */
  extraFacets?: readonly SearchFacet[];
  /** Sort, grouping and toggles, behind the View button. */
  view?: readonly ViewSection[];
}

/** The workflow facets every workflow-based page filters by. */
export function workflowFacets(
  filter: WorkflowFilter,
  onChange: (next: WorkflowFilter) => void,
  prefixes: ReadonlyArray<{ prefix: string; count: number }>,
  webhooks: readonly string[],
): SearchFacet[] {
  return [
    {
      key: "prefix",
      label: "Prefix",
      description: "Workflows whose name starts with a prefix",
      values: prefixes.map((p) => ({
        value: p.prefix,
        label: p.prefix,
        hint: formatCount(p.count),
      })),
      selected: filter.prefixes,
      onSelect: (v) => onChange({ ...filter, prefixes: v }),
    },
    {
      key: "trigger",
      label: "Trigger",
      description: "What starts the workflow: cron, webhook or manual",
      values: TRIGGERS.map((t) => ({
        value: t,
        label: TRIGGER_LABELS[t],
        detail: TRIGGER_DESCRIPTIONS[t],
      })),
      selected: filter.triggers,
      onSelect: (v) =>
        onChange({ ...filter, triggers: v as readonly TriggerKind[] }),
    },
    {
      key: "webhook",
      label: "Webhook",
      description: "Workflows a webhook route starts",
      values: webhooks.map((w) => ({ value: w, label: w })),
      selected: filter.webhooks,
      onSelect: (v) => onChange({ ...filter, webhooks: v }),
    },
  ];
}

/**
 * The workflow pages' guided search: one box for names and every facet
 * (prefix, trigger, webhook, plus any page-specific ones), and a View
 * button for sort and grouping.
 */
export function FilterBar(
  {
    filter,
    onChange,
    prefixes,
    webhooks,
    placeholder = "Search workflows or filter by prefix, trigger, webhook…",
    shown,
    total,
    noun = "workflows",
    extraFacets = [],
    view,
  }: FilterBarProps,
) {
  const facets = [
    ...workflowFacets(filter, onChange, prefixes, webhooks),
    ...extraFacets,
  ];
  return (
    <SearchBar
      query={filter.query}
      onQuery={(query) => onChange({ ...filter, query })}
      facets={facets}
      placeholder={placeholder}
      shown={shown}
      total={total}
      noun={noun}
      onClear={() => {
        onChange(EMPTY_FILTER);
        for (const f of extraFacets) f.onSelect([]);
      }}
      trailing={view && view.length > 0 ? <ViewMenu sections={view} /> : null}
    />
  );
}
