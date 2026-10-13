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

import { type MouseEvent, useMemo } from "react";
import { useRequest } from "../client/useRequest.ts";
import { extractArray } from "../client/extract.ts";
import {
  asString,
  oneOf,
  useQueryList,
  useQueryState,
} from "../client/useQueryState.ts";
import {
  describeTimeRange,
  useTimeBounds,
  useTimeRange,
} from "../client/time_range.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { SearchBar, type SearchFacet } from "../components/SearchBar.tsx";
import { ViewMenu } from "../components/ViewMenu.tsx";
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
import {
  behaviorNoun,
  BEHAVIORS_LABEL,
  NO_BEHAVIORS_TITLE,
} from "../lib/behavior_labels.ts";
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
  const [types, setTypes] = useQueryList("type");
  const [prefixes, setPrefixes] = useQueryList("prefix");
  const filter = useMemo(() => ({ query, types, prefixes }), [
    query,
    types,
    prefixes,
  ]);
  const set = (next: ModelFilter) => {
    if (next.query !== query) setQuery(next.query);
    if (next.types !== types) setTypes(next.types);
    if (next.prefixes !== prefixes) setPrefixes(next.prefixes);
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
  const rangeText = describeTimeRange(range);
  const truncated = extractArray<ModelOutput>(outputData).length >=
    OUTPUT_LIMIT;

  const typeCount = new Set(models.map((m) => m.type)).size;
  const stats: Stat[] = [
    {
      label: behaviorNoun(models.length),
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
        <h1>{BEHAVIORS_LABEL}</h1>
        <div className="header-right">
          {loaded ? <StatPills stats={stats} label="Behaviors summary" /> : (
            !error && <SkeletonPills count={4} />
          )}
        </div>
      </div>

      {error
        ? (
          <div className="panel">
            <EmptyState
              title="Couldn't load behaviors"
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
        ? <SkeletonCardGrid label="Loading behaviors" />
        : models.length === 0
        ? (
          <div className="panel">
            <EmptyState title={NO_BEHAVIORS_TITLE}>
              Create one with{" "}
              <code>swamp behavior create</code>, then it shows up here with its
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
            />
            {shown.length === 0
              ? (
                <div className="panel">
                  <EmptyState
                    title="No behaviors match these filters"
                    action={
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() =>
                          setFilter({ query: "", types: [], prefixes: [] })}
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
  { filter, onChange, models, shown, sort, onSort }: {
    filter: ModelFilter;
    onChange: (next: ModelFilter) => void;
    models: readonly ModelSummary[];
    shown: number;
    sort: ModelSort;
    onSort: (s: ModelSort) => void;
  },
) {
  const types = modelTypeOptions(models);
  const prefixes = modelPrefixOptions(models);
  const facets: SearchFacet[] = [
    {
      key: "type",
      label: "Type",
      description: "Behaviors of one behavior type",
      values: types.length > 1 ? types : [],
      selected: filter.types,
      onSelect: (v) => onChange({ ...filter, types: v }),
    },
    {
      key: "prefix",
      label: "Prefix",
      description: "Behaviors whose name starts with a prefix",
      values: prefixes.length > 1 ? prefixes : [],
      selected: filter.prefixes,
      onSelect: (v) => onChange({ ...filter, prefixes: v }),
    },
  ];
  return (
    <SearchBar
      query={filter.query}
      onQuery={(query) => onChange({ ...filter, query })}
      facets={facets}
      placeholder="Search behaviors or filter by type, prefix…"
      shown={shown}
      total={models.length}
      noun="behaviors"
      onClear={() => onChange({ query: "", types: [], prefixes: [] })}
      trailing={
        <ViewMenu
          sections={[{
            kind: "choice",
            label: "Sort",
            value: sort,
            defaultValue: SORTS[0],
            options: SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] })),
            onChange: (v) => onSort(v as ModelSort),
          }]}
        />
      }
    />
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
