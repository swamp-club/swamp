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

import { useEffect, useMemo, useState } from "react";
import type { HealthSnapshot } from "../client/useHealthStream.ts";
import {
  type CatalogWorkflow,
  useWorkflowCatalog,
} from "../client/useWorkflowCatalog.ts";
import {
  type RunSummaryData,
  summariesByName,
  useRunSummary,
  type WorkflowRunSummary,
} from "../client/run_summary.ts";
import { describeTimeRange, useTimeRange } from "../client/time_range.ts";
import {
  asFlag,
  flagParam,
  oneOf,
  useQueryState,
} from "../client/useQueryState.ts";
import {
  FilterBar,
  type SelectOption,
  useWorkflowFilter,
} from "../components/FilterBar.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { SkeletonCardGrid, SkeletonPills } from "../components/Skeleton.tsx";
import { type Stat, StatPills } from "../components/StatPills.tsx";
import {
  applyWorkflowFilter,
  EMPTY_FILTER,
  type GroupBy,
  groupWorkflows,
  isFilterActive,
} from "../lib/workflow_facets.ts";
import {
  formatCompactCount,
  formatCount,
  formatDuration,
  pluralize,
} from "../lib/format.ts";
import { WorkflowCard } from "./WorkflowCard.tsx";
import {
  aggregateRuns,
  formatPassRate,
  partitionByActivity,
  resolveSort,
  sortWorkflows,
  takeAcrossGroups,
  WORKFLOW_SORTS,
  type WorkflowSort,
} from "./workflow_list.ts";
import "../styles/workflows.css";

interface WorkflowsProps {
  health: HealthSnapshot | null;
  onOpenWorkflow?: (workflowName: string) => void;
}

/** Cards rendered per step; more appear as the list scrolls. */
const PAGE = 60;

const GROUPS: readonly GroupBy[] = ["none", "prefix", "trigger", "webhook"];

const GROUP_LABELS: Record<GroupBy, string> = {
  none: "None",
  prefix: "Prefix",
  trigger: "Trigger",
  webhook: "Webhook",
};

const SORT_LABELS: Record<Exclude<WorkflowSort, "auto">, string> = {
  recent: "Recent activity",
  name: "Name",
  runs: "Most runs",
  failures: "Most failures",
  time: "Longest total time",
};

export function Workflows({ health, onOpenWorkflow }: WorkflowsProps) {
  const catalog = useWorkflowCatalog(health);
  const {
    summary: fresh,
    loading: summaryLoading,
    error: summaryError,
  } = useRunSummary({ recentLimit: 20 });
  const { range } = useTimeRange();
  const rangeLabel = describeTimeRange(range);

  // A preset's bounds roll forward every minute, which re-keys the request
  // and clears its data. Keep showing the last summary for the same range
  // while the next one loads instead of flashing the skeleton.
  const rangeKey = JSON.stringify(range);
  const [held, setHeld] = useState<
    { key: string; data: RunSummaryData } | null
  >(null);
  if (fresh && (held?.data !== fresh || held.key !== rangeKey)) {
    setHeld({ key: rangeKey, data: fresh });
  }
  const summary = fresh ?? (held?.key === rangeKey ? held.data : null);

  const [filter, setFilter] = useWorkflowFilter();
  const [group, setGroup] = useQueryState<GroupBy>(
    "group",
    "none",
    oneOf(GROUPS, "none"),
  );
  const [sort, setSort] = useQueryState<WorkflowSort>(
    "sort",
    "auto",
    oneOf(WORKFLOW_SORTS, "auto"),
  );
  const [showAll, setShowAll] = useQueryState("all", false, asFlag, flagParam);

  // The summary is "pending" until it answers; once it fails the page still
  // lists workflows, just without run data.
  const summaryUnavailable = summary === null && summaryError !== null;
  const summaryPending = summary === null && !summaryUnavailable &&
    summaryLoading;
  const stats = useMemo(() => summariesByName(summary), [summary]);
  const statsOf = (w: CatalogWorkflow): WorkflowRunSummary | undefined =>
    stats.get(w.name);

  const cronByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of health?.scheduling?.schedules ?? []) {
      map.set(s.workflowName, s.cronExpression);
    }
    return map;
  }, [health?.scheduling?.schedules]);

  const effectiveSort = resolveSort(sort, filter.query);
  const hideIdle = !showAll && summary !== null;

  const { visible, neverRanCount, filteredCount } = useMemo(() => {
    const filtered = applyWorkflowFilter(
      catalog.workflows,
      filter,
      (w) => w,
      catalog.facetsOf,
    );
    // Without run data the activity orders mean nothing: fall back to name.
    const order = summary === null && effectiveSort !== "relevance"
      ? "name"
      : effectiveSort;
    const sorted = sortWorkflows(filtered, order, (w) => stats.get(w.name));
    const { ran, neverRan } = partitionByActivity(
      sorted,
      (w) => stats.get(w.name),
    );
    return {
      visible: hideIdle ? ran : sorted,
      neverRanCount: summary === null ? 0 : neverRan.length,
      filteredCount: filtered.length,
    };
  }, [
    catalog.workflows,
    catalog.facetsOf,
    filter,
    effectiveSort,
    stats,
    summary,
    hideIdle,
  ]);

  const groups = useMemo(
    () => groupWorkflows(visible, group, (w) => w, catalog.facetsOf),
    [visible, group, catalog.facetsOf],
  );

  // Progressive rendering: the limit resets whenever the list changes shape.
  const resetKey = JSON.stringify([filter, group, effectiveSort, showAll]);
  const [paging, setPaging] = useState({ key: resetKey, limit: PAGE });
  const limit = paging.key === resetKey ? paging.limit : PAGE;
  const paged = takeAcrossGroups(groups, limit);
  const remaining = paged.total - paged.shown;
  const showMore = () => setPaging({ key: resetKey, limit: limit + PAGE });

  // A callback ref, so the observer attaches whenever the sentinel mounts
  // (it only exists once the list has rendered and there is more to show).
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setPaging({ key: resetKey, limit: limit + PAGE });
      }
    }, { rootMargin: "800px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, limit, resetKey]);

  const filtering = isFilterActive(filter);
  const loadingList = catalog.loading || summaryPending;

  // Sort select: "auto" reads as "Best match" while searching and as
  // "Recent activity" otherwise, so the default never shows twice.
  const searching = filter.query.trim() !== "";
  const sortOptions: SelectOption<WorkflowSort>[] = searching
    ? [
      { value: "auto", label: "Best match" },
      { value: "recent", label: SORT_LABELS.recent },
    ]
    : [{ value: "auto", label: SORT_LABELS.recent }];
  for (const s of ["name", "runs", "failures", "time"] as const) {
    sortOptions.push({ value: s, label: SORT_LABELS[s] });
  }
  const sortValue: WorkflowSort = !searching && sort === "recent"
    ? "auto"
    : sort;
  const groupOptions = GROUPS
    .filter((g) => g !== "webhook" || catalog.webhookRoutes.length > 0)
    .map((g) => ({ value: g, label: GROUP_LABELS[g] }));

  const fullGroupSize = new Map(groups.map((g) => [g.key, g.items]));

  return (
    <>
      <div className="page-header">
        <h1>Workflows</h1>
        <div className="header-right">
          {catalog.loading || summaryPending
            ? <SkeletonPills count={5} />
            : (
              <StatPills
                label={`Workflow runs, ${rangeLabel.toLowerCase()}`}
                stats={headerStats(
                  catalog.workflows.length,
                  summary?.totals ?? null,
                  rangeLabel,
                )}
              />
            )}
        </div>
      </div>

      <FilterBar
        filter={filter}
        onChange={setFilter}
        prefixes={catalog.prefixes}
        webhooks={catalog.webhookRoutes}
        shown={visible.length}
        total={catalog.workflows.length}
        view={[
          {
            kind: "choice",
            label: "Sort",
            value: sortValue,
            defaultValue: sortOptions[0].value,
            options: sortOptions,
            onChange: (v) =>
              setSort(
                (v === "recent" && !searching ? "auto" : v) as typeof sort,
              ),
          },
          {
            kind: "choice",
            label: "Group by",
            value: group,
            defaultValue: "none",
            options: groupOptions,
            onChange: (v) => setGroup(v as typeof group),
          },
          ...(summary !== null && (neverRanCount > 0 || showAll)
            ? [{
              kind: "toggle" as const,
              label: `Show never run (${formatCount(neverRanCount)})`,
              checked: showAll,
              onChange: setShowAll,
            }]
            : []),
        ]}
      />

      {summaryUnavailable && !catalog.loading && (
        <div className="notice notice-warning" role="status">
          <span>
            Run history isn't available from this server, so workflows are
            listed by name without run counts.
          </span>
        </div>
      )}

      {loadingList
        ? <SkeletonCardGrid count={9} label="Loading workflows" />
        : catalog.error && catalog.workflows.length === 0
        ? (
          <EmptyState title="Couldn't load workflows">
            {catalog.error}
          </EmptyState>
        )
        : catalog.workflows.length === 0
        ? (
          <EmptyState title="No workflows yet">
            Create one with <code>swamp workflow create</code>{" "}
            and it will appear here.
          </EmptyState>
        )
        : visible.length === 0
        ? (
          <EmptyState
            title={filtering && filteredCount === 0
              ? "No workflows match these filters"
              : filtering
              ? `No matching workflows ran (${rangeLabel.toLowerCase()})`
              : `No workflows ran (${rangeLabel.toLowerCase()})`}
            action={
              <span className="wf-empty-actions">
                {neverRanCount > 0 && !showAll && (
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={() => setShowAll(true)}
                  >
                    Show {pluralize(neverRanCount, "never-run workflow")}
                  </button>
                )}
                {filtering && (
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={() => setFilter(EMPTY_FILTER)}
                  >
                    Clear filters
                  </button>
                )}
              </span>
            }
          >
            {filtering && filteredCount === 0
              ? "Try a different search, or clear the filters."
              : "Widen the time range, or include workflows that haven't run."}
          </EmptyState>
        )
        : (
          <>
            {paged.groups.map((g) => {
              const cards = (
                <div className="card-grid wf-grid">
                  {g.items.map((w) => (
                    <WorkflowCard
                      key={w.id}
                      workflow={w}
                      facets={catalog.facetsOf(w)}
                      cron={w.trigger?.schedule ?? cronByName.get(w.name)}
                      summary={statsOf(w)}
                      summaryUnavailable={summaryUnavailable}
                      onOpen={onOpenWorkflow}
                    />
                  ))}
                </div>
              );
              if (group === "none") return <div key={g.key}>{cards}</div>;
              const all = fullGroupSize.get(g.key) ?? g.items;
              const agg = aggregateRuns(all, statsOf);
              const headingId = `wf-group-${g.key}`;
              return (
                <section
                  key={g.key}
                  className="wf-group"
                  aria-labelledby={headingId}
                >
                  <h2 className="group-heading wf-group-heading" id={headingId}>
                    <span className="wf-group-label">{g.label}</span>
                    <span
                      className="panel-count"
                      title={pluralize(all.length, "workflow")}
                    >
                      {formatCount(all.length)}
                    </span>
                    {summary !== null && agg.runs > 0 && (
                      <span
                        className="wf-group-agg"
                        title={`${pluralize(agg.runs, "run")}, ${
                          formatCount(agg.failed)
                        } failed`}
                      >
                        {formatCompactCount(agg.runs)}{" "}
                        {agg.runs === 1 ? "run" : "runs"}
                        {agg.passRate !== null && (
                          <>
                            {" · "}
                            <span
                              className={agg.failed > 0
                                ? "wf-group-rate has-failures"
                                : "wf-group-rate"}
                            >
                              {formatPassRate(agg.passRate)} pass
                            </span>
                          </>
                        )}
                      </span>
                    )}
                  </h2>
                  {cards}
                </section>
              );
            })}
            {remaining > 0 && (
              <div className="wf-more" ref={setSentinel}>
                <button type="button" className="btn-sm" onClick={showMore}>
                  Show {formatCount(Math.min(PAGE, remaining))} more
                </button>
                <span className="wf-more-count">
                  {formatCount(paged.shown)} of {formatCount(paged.total)}
                </span>
              </div>
            )}
          </>
        )}
    </>
  );
}

function headerStats(
  workflowCount: number,
  totals: RunSummaryData["totals"] | null,
  rangeLabel: string,
): Stat[] {
  const workflows: Stat = {
    label: workflowCount === 1 ? "workflow" : "workflows",
    value: formatCompactCount(workflowCount),
    title: totals
      ? `${pluralize(workflowCount, "workflow")}; ${
        formatCount(totals.workflows)
      } ran (${rangeLabel.toLowerCase()})`
      : pluralize(workflowCount, "workflow"),
  };
  if (!totals) return [workflows];
  const range = ` (${rangeLabel.toLowerCase()})`;
  const stats: Stat[] = [
    workflows,
    {
      label: totals.runs === 1 ? "execution" : "executions",
      value: formatCompactCount(totals.runs),
      title: `${pluralize(totals.runs, "execution")}${range}`,
    },
    {
      label: "passed",
      value: formatCompactCount(totals.succeeded),
      tone: totals.succeeded > 0 ? "success" : "neutral",
      title: `${formatCount(totals.succeeded)} passed${range}`,
    },
    {
      label: "failed",
      value: formatCompactCount(totals.failed),
      tone: totals.failed > 0 ? "danger" : "neutral",
      title: `${formatCount(totals.failed)} failed${range}`,
    },
  ];
  if (totals.running > 0) {
    stats.push({
      label: "running",
      value: formatCompactCount(totals.running),
      tone: "running",
      title: `${pluralize(totals.running, "run")} in progress`,
    });
  }
  stats.push({
    label: "total time",
    value: formatDuration(totals.durationMs),
    title: `${
      formatCount(Math.round(totals.durationMs / 1000))
    } seconds of execution across finished runs${range}`,
  });
  return stats;
}
