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

import { type MouseEvent, useEffect, useMemo, useRef } from "react";
import { useRequest } from "../client/useRequest.ts";
import { extractArray } from "../client/extract.ts";
import {
  asNullableString,
  asString,
  nullableParam,
  oneOf,
  useQueryState,
} from "../client/useQueryState.ts";
import {
  describeTimeRange,
  useTimeBounds,
  useTimeRange,
} from "../client/time_range.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { FilterSelect } from "../components/FilterBar.tsx";
import { RouteLink } from "../components/RouteLink.tsx";
import { RunHistoryBar } from "../components/RunHistoryBar.tsx";
import {
  Skeleton,
  SkeletonCardGrid,
  SkeletonPills,
  SkeletonRunHistory,
} from "../components/Skeleton.tsx";
import { type Stat, StatPills } from "../components/StatPills.tsx";
import {
  formatAbsoluteTime,
  formatCompactCount,
  formatCount,
  formatRelativeTime,
} from "../lib/format.ts";
import {
  filterModels,
  type ModelFilter,
  modelPrefixOptions,
  type ModelSort,
  type ModelSummary,
  modelTypeOptions,
  partialCount,
  partialPlural,
  sortModels,
} from "./model_list.ts";
import {
  filterOutputs,
  type ModelOutput,
  type ModelUsage,
  outputPips,
  usageByModel,
} from "./model_executions.ts";
import "../styles/models.css";

interface ModelsProps {
  onOpenModel?: (modelName: string) => void;
}

/** Outputs fetched for the whole page's usage; one request, no per-card calls. */
const OUTPUT_LIMIT = 5000;
const SORTS: readonly ModelSort[] = ["name", "recent", "busy"];
const SORT_LABELS: Record<ModelSort, string> = {
  name: "Name",
  recent: "Recently used",
  busy: "Most executions",
};
const MAX_CHIPS = 4;

type UsageState = "loading" | "loaded" | "failed";

function useModelFilter(): [ModelFilter, (next: ModelFilter) => void] {
  const [query, setQuery] = useQueryState("q", "", asString);
  const [type, setType] = useQueryState<string | null>(
    "type",
    null,
    asNullableString,
    nullableParam,
  );
  const [prefix, setPrefix] = useQueryState<string | null>(
    "prefix",
    null,
    asNullableString,
    nullableParam,
  );
  const filter = useMemo(() => ({ query, type, prefix }), [
    query,
    type,
    prefix,
  ]);
  const set = (next: ModelFilter) => {
    if (next.query !== query) setQuery(next.query);
    if (next.type !== type) setType(next.type);
    if (next.prefix !== prefix) setPrefix(next.prefix);
  };
  return [filter, set];
}

export function Models({ onOpenModel }: ModelsProps) {
  const { data, error, refetch } = useRequest("model.search");
  const bounds = useTimeBounds();
  const { range } = useTimeRange();
  const { data: outputData, error: outputError } = useRequest(
    "model.output.search",
    {
      ...bounds,
      limit: OUTPUT_LIMIT,
    },
  );
  const usageState: UsageState = outputData !== null
    ? "loaded"
    : outputError
    ? "failed"
    : "loading";

  const [filter, setFilter] = useModelFilter();
  const [sort, setSort] = useQueryState<ModelSort>(
    "sort",
    "name",
    oneOf(SORTS, "name"),
  );

  const models = useMemo(() => extractArray<ModelSummary>(data), [data]);
  const outputs = useMemo(
    () => filterOutputs(extractArray<ModelOutput>(outputData), bounds),
    [outputData, bounds],
  );
  const usage = useMemo(() => usageByModel(outputs), [outputs]);
  const usageOf = (m: ModelSummary): ModelUsage | undefined =>
    usage.get(m.id) ?? usage.get(m.name);

  const shown = useMemo(
    () =>
      sortModels(
        filterModels(models, filter),
        filter.query.trim() ? "relevance" : sort,
        (m) => usage.get(m.id) ?? usage.get(m.name),
      ),
    [models, filter, sort, usage],
  );

  const loaded = data !== null;
  const active = Boolean(filter.query || filter.type || filter.prefix);
  const rangeText = describeTimeRange(range);
  const truncated = extractArray<ModelOutput>(outputData).length >=
    OUTPUT_LIMIT;

  const typeCount = new Set(models.map((m) => m.type)).size;
  const stats: Stat[] = [
    {
      label: models.length === 1 ? "model" : "models",
      value: formatCount(models.length),
    },
    {
      label: typeCount === 1 ? "type" : "types",
      value: formatCount(typeCount),
    },
  ];
  if (outputData !== null) {
    const failed = outputs.filter((o) => o.status === "failed").length;
    stats.push({
      label: "executions",
      value: `${formatCompactCount(outputs.length)}${truncated ? "+" : ""}`,
      title: `${formatCount(outputs.length)} method runs · ${rangeText}`,
    });
    stats.push({
      label: "failed",
      value: `${formatCompactCount(failed)}${truncated ? "+" : ""}`,
      tone: failed > 0 ? "danger" : "neutral",
      title: `Failed method runs · ${rangeText}`,
    });
  } else if (usageState === "loading") {
    const pending = <Skeleton width={24} height={11} />;
    stats.push({ label: "executions", value: pending });
    stats.push({ label: "failed", value: pending });
  }

  return (
    <>
      <div className="page-header">
        <h1>Models</h1>
        <div className="header-right">
          {loaded ? <StatPills stats={stats} label="Models summary" /> : (
            !error && <SkeletonPills count={4} />
          )}
        </div>
      </div>

      {error
        ? (
          <div className="panel">
            <EmptyState
              title="Couldn't load models"
              action={
                <button type="button" className="btn-sm" onClick={refetch}>
                  Retry
                </button>
              }
            >
              {error}
            </EmptyState>
          </div>
        )
        : !loaded
        ? <SkeletonCardGrid label="Loading models" />
        : models.length === 0
        ? (
          <div className="panel">
            <EmptyState title="No models defined yet">
              Create one with{" "}
              <code>swamp model create</code>, then it shows up here with its
              inputs, outputs and executions.
            </EmptyState>
          </div>
        )
        : (
          <>
            <ModelFilterBar
              filter={filter}
              onChange={setFilter}
              models={models}
              shown={shown.length}
              sort={sort}
              onSort={setSort}
              active={active}
            />
            {shown.length === 0
              ? (
                <div className="panel">
                  <EmptyState
                    title="No models match these filters"
                    action={
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() =>
                          setFilter({ query: "", type: null, prefix: null })}
                      >
                        Clear filters
                      </button>
                    }
                  />
                </div>
              )
              : (
                <div className="card-grid">
                  {shown.map((m) => (
                    <ModelCard
                      key={m.id}
                      model={m}
                      usage={usageOf(m)}
                      usageState={usageState}
                      rangeText={rangeText}
                      partial={truncated}
                      onOpen={onOpenModel}
                    />
                  ))}
                </div>
              )}
          </>
        )}
    </>
  );
}

function ModelFilterBar(
  { filter, onChange, models, shown, sort, onSort, active }: {
    filter: ModelFilter;
    onChange: (next: ModelFilter) => void;
    models: readonly ModelSummary[];
    shown: number;
    sort: ModelSort;
    onSort: (s: ModelSort) => void;
    active: boolean;
  },
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

  const types = modelTypeOptions(models);
  const prefixes = modelPrefixOptions(models);

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
          placeholder="Search models and types"
          aria-label="Search models and types"
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

      {types.length > 1 && (
        <FilterSelect
          label="Type"
          value={filter.type ?? ""}
          onChange={(v) => onChange({ ...filter, type: v || null })}
          options={[{ value: "", label: "All types" }, ...types]}
        />
      )}

      {prefixes.length > 1 && (
        <FilterSelect
          label="Prefix"
          value={filter.prefix ?? ""}
          onChange={(v) => onChange({ ...filter, prefix: v || null })}
          options={[{ value: "", label: "All prefixes" }, ...prefixes]}
        />
      )}

      <FilterSelect
        label="Sort"
        value={sort}
        onChange={onSort}
        options={SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
      />

      <div className="filter-summary">
        {active && (
          <>
            <span aria-live="polite">
              {formatCount(shown)} of {formatCount(models.length)} models
            </span>
            <button
              type="button"
              className="filter-clear"
              onClick={() => onChange({ query: "", type: null, prefix: null })}
            >
              Clear filters
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ModelCard(
  { model, usage, usageState, rangeText, partial, onOpen }: {
    model: ModelSummary;
    usage: ModelUsage | undefined;
    /** Usage comes from one page-wide request; "failed" hides the strip. */
    usageState: UsageState;
    rangeText: string;
    /** The page-wide request hit its cap: counts are lower bounds. */
    partial: boolean;
    onOpen?: (name: string) => void;
  },
) {
  const methods = model.methods ?? usage?.methods ?? [];
  const chips = methods.slice(0, MAX_CHIPS);
  const extra = methods.length - chips.length;
  const onClick = (e: MouseEvent<HTMLElement>) => {
    // The name and the pips are real links; let them handle their clicks.
    if ((e.target as Element).closest("a, button")) return;
    onOpen?.(model.name);
  };
  return (
    <article className="card model-card" onClick={onClick}>
      <div className="card-header">
        <RouteLink
          className="card-name model-card-name"
          to={{
            view: "models",
            detail: { kind: "model", modelName: model.name },
          }}
          title={model.name}
        >
          {model.name}
        </RouteLink>
        <span className="model-card-type" title={model.type}>
          {model.type}
        </span>
      </div>
      {chips.length > 0 && (
        <ul
          className="model-chips"
          aria-label={model.methods ? "Methods" : `Methods run · ${rangeText}`}
        >
          {chips.map((name) => (
            <li key={name} className="model-chip">{name}</li>
          ))}
          {extra > 0 && (
            <li
              className="model-chip more"
              title={methods.slice(MAX_CHIPS).join(", ")}
            >
              +{extra}
            </li>
          )}
        </ul>
      )}
      {usageState === "loading" && (
        <>
          <SkeletonRunHistory slots={20} height={8} />
          <div className="model-card-foot" aria-hidden="true">
            <Skeleton width={110} height={10} />
            <Skeleton width={44} height={10} />
          </div>
        </>
      )}
      {usageState === "loaded" && (
        <>
          <RunHistoryBar
            runs={outputPips(usage?.recent ?? [])}
            slots={20}
            height={8}
            noun="executions"
          />
          <div className="model-card-foot">
            {usage?.lastStartedAt
              ? (
                <span title={formatAbsoluteTime(usage.lastStartedAt)}>
                  Last used{" "}
                  <time dateTime={usage.lastStartedAt}>
                    {formatRelativeTime(usage.lastStartedAt)}
                  </time>
                </span>
              )
              : (
                <span>
                  {partial
                    ? `No executions in the newest ${formatCount(OUTPUT_LIMIT)}`
                    : `No executions · ${rangeText}`}
                </span>
              )}
            {usage && (
              <span
                title={partial
                  ? `Counted from the newest ${
                    formatCount(OUTPUT_LIMIT)
                  } executions · ${rangeText}`
                  : undefined}
              >
                {partialPlural(usage.executions, "run", partial)}
                {usage.failed > 0 && (
                  <span className="tone-danger">
                    {` · ${partialCount(usage.failed, partial)} failed`}
                  </span>
                )}
              </span>
            )}
          </div>
        </>
      )}
    </article>
  );
}
