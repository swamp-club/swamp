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

import { type ReactNode, useEffect, useId, useMemo, useRef } from "react";
import { Select, type SelectOption } from "./Select.tsx";
import {
  asNullableString,
  asString,
  nullableParam,
  oneOf,
  useQueryState,
} from "../client/useQueryState.ts";
import {
  EMPTY_FILTER,
  isFilterActive,
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
  /** Group/sort selects and toggles, rendered on the right. */
  children?: ReactNode;
}

/**
 * Search, prefix, trigger and webhook filters shared by the workflow-based
 * pages. "/" focuses the search box from anywhere on the page.
 */
export function FilterBar(
  {
    filter,
    onChange,
    prefixes,
    webhooks,
    placeholder = "Search workflows",
    shown,
    total,
    noun = "workflows",
    children,
  }: FilterBarProps,
) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const active = isFilterActive(filter);

  return (
    <div className="filter-bar" role="search">
      <div className="filter-search">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="5" />
          <path d="M11 11l3.5 3.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          value={filter.query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter.query) {
              e.stopPropagation();
              onChange({ ...filter, query: "" });
            }
          }}
        />
        {!filter.query && <kbd aria-hidden="true">/</kbd>}
      </div>

      <div className="time-range" role="group" aria-label="Trigger">
        {TRIGGERS.map((t) => (
          <button
            type="button"
            key={t}
            className={filter.trigger === t ? "active" : ""}
            aria-pressed={filter.trigger === t}
            onClick={() => onChange({ ...filter, trigger: t })}
          >
            {TRIGGER_LABELS[t]}
          </button>
        ))}
      </div>

      {prefixes.length > 0 && (
        <FilterSelect
          label="Prefix"
          value={filter.prefix ?? ""}
          onChange={(v) => onChange({ ...filter, prefix: v || null })}
          options={[
            { value: "", label: "All prefixes" },
            ...prefixes.map((p) => ({
              value: p.prefix,
              label: p.prefix,
              hint: formatCount(p.count),
            })),
          ]}
        />
      )}

      {webhooks.length > 0 && (
        <FilterSelect
          label="Webhook"
          value={filter.webhook ?? ""}
          onChange={(v) => onChange({ ...filter, webhook: v || null })}
          options={[
            { value: "", label: "Any webhook" },
            ...webhooks.map((w) => ({ value: w, label: w })),
          ]}
        />
      )}

      {children}

      <div className="filter-summary">
        {active && shown !== undefined && total !== undefined && (
          <span aria-live="polite">
            {formatCount(shown)} of {formatCount(total)} {noun}
          </span>
        )}
        {active && (
          <button
            type="button"
            className="filter-clear"
            onClick={() => onChange(EMPTY_FILTER)}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

/** A labelled dropdown styled to match the filter bar. */
export function FilterSelect<T extends string>(
  { label, value, onChange, options }: {
    label: string;
    value: T;
    onChange: (value: T) => void;
    options: ReadonlyArray<SelectOption<T>>;
  },
) {
  const labelId = useId();
  return (
    <div className="filter-select">
      <span id={labelId}>{label}</span>
      <Select
        value={value}
        onChange={onChange}
        options={options}
        labelledBy={labelId}
      />
    </div>
  );
}

/** A checkbox toggle styled to match the filter bar. */
export function FilterToggle(
  { label, checked, onChange }: {
    label: ReactNode;
    checked: boolean;
    onChange: (checked: boolean) => void;
  },
) {
  return (
    <label className="filter-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
