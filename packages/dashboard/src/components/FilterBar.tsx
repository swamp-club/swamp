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
  asNullableString,
  asString,
  nullableParam,
  oneOf,
  useQueryState,
} from "../client/useQueryState.ts";
import {
  EMPTY_FILTER,
  type TriggerFilter,
  type WorkflowFilter,
} from "../lib/workflow_facets.ts";
import { formatCount } from "../lib/format.ts";

const TRIGGERS: readonly TriggerFilter[] = [
  "all",
  "schedule",
  "webhook",
  "manual",
];

const TRIGGER_LABELS: Record<TriggerFilter, string> = {
  all: "All",
  schedule: "Cron",
  webhook: "Webhook",
  manual: "Manual",
};

/** The shared workflow filter, mirrored to ?q=&prefix=&trigger=&webhook=. */
export function useWorkflowFilter(): [
  WorkflowFilter,
  (next: WorkflowFilter) => void,
] {
  const [query, setQuery] = useQueryState("q", "", asString);
  const [prefix, setPrefix] = useQueryState<string | null>(
    "prefix",
    null,
    asNullableString,
    nullableParam,
  );
  const [trigger, setTrigger] = useQueryState<TriggerFilter>(
    "trigger",
    "all",
    oneOf(TRIGGERS, "all"),
  );
  const [webhook, setWebhook] = useQueryState<string | null>(
    "webhook",
    null,
    asNullableString,
    nullableParam,
  );
  const filter = useMemo(
    () => ({ query, prefix, trigger, webhook }),
    [query, prefix, trigger, webhook],
  );
  const set = (next: WorkflowFilter) => {
    if (next.query !== query) setQuery(next.query);
    if (next.prefix !== prefix) setPrefix(next.prefix);
    if (next.trigger !== trigger) setTrigger(next.trigger);
    if (next.webhook !== webhook) setWebhook(next.webhook);
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

const TRIGGER_DESCRIPTIONS: Record<Exclude<TriggerFilter, "all">, string> = {
  schedule: "Runs on a cron schedule",
  webhook: "Started by a webhook",
  manual: "Only run by hand or the API",
};

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
      selected: filter.prefix,
      onSelect: (v) => onChange({ ...filter, prefix: v }),
    },
    {
      key: "trigger",
      label: "Trigger",
      description: "What starts the workflow: cron, webhook or manual",
      values: TRIGGERS.filter((t) => t !== "all").map((t) => ({
        value: t,
        label: `${TRIGGER_LABELS[t]} — ${
          TRIGGER_DESCRIPTIONS[t as Exclude<TriggerFilter, "all">]
        }`,
      })),
      selected: filter.trigger === "all" ? null : filter.trigger,
      onSelect: (v) =>
        onChange({ ...filter, trigger: (v ?? "all") as TriggerFilter }),
    },
    {
      key: "webhook",
      label: "Webhook",
      description: "Workflows a webhook route starts",
      values: webhooks.map((w) => ({ value: w, label: w })),
      selected: filter.webhook,
      onSelect: (v) => onChange({ ...filter, webhook: v }),
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
        for (const f of extraFacets) f.onSelect(null);
      }}
      trailing={view && view.length > 0 ? <ViewMenu sections={view} /> : null}
    />
  );
}
