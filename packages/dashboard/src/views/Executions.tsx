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

import { type MouseEvent, useCallback, useMemo, useState } from "react";
import { useRequest } from "../client/useRequest";
import { extractArray, extractTotal } from "../client/extract";
import type { HealthSnapshot } from "../client/useHealthStream";
import { useWorkflowCatalog } from "../client/useWorkflowCatalog";
import { useKeepPrevious } from "../client/useKeepPrevious";
import {
  type RunSummaryQuery,
  summariesByName,
  useRunSummary,
} from "../client/run_summary";
import {
  describeTimeRange,
  type TimeRange,
  useTimeRange,
} from "../client/time_range";
import { oneOf, useQueryState } from "../client/useQueryState";
import { StatusPill } from "../components/StatusPill";
import { TriggerBadge } from "../components/TriggerBadge";
import { Pager } from "../components/Pager";
import { RouteLink } from "../components/RouteLink";
import { RunHistoryBar } from "../components/RunHistoryBar";
import { type Stat, StatPills } from "../components/StatPills";
import { EmptyState } from "../components/EmptyState";
import {
  FilterBar,
  FilterSelect,
  useWorkflowFilter,
} from "../components/FilterBar";
import { RunStatusFilter } from "../components/RunStatusFilter";
import { FailureLink } from "../components/FailureLink";
import {
  type SkeletonColumn,
  SkeletonPills,
  SkeletonRunHistory,
  SkeletonTable,
} from "../components/Skeleton";
import { EMPTY_FILTER, isFilterActive } from "../lib/workflow_facets";
import {
  RUN_SOURCE_LABELS,
  RUN_SOURCES,
  RUN_STATUSES,
  runSearchPayload,
  runSearchWindow,
  type RunSourceFilter,
  type RunStatusFilter as StatusValue,
  splitWorkflowFilter,
  statusCounts,
  totalsOfWorkflows,
  workflowNamesForFilter,
} from "../lib/run_filters";
import {
  formatAbsoluteTime,
  formatCount,
  formatDuration,
  formatRelativeTime,
  formatShortDateTime,
} from "../lib/format";
import "../styles/executions.css";

interface RunItem {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  duration?: number;
  triggerSource?: string;
  stepProgress?: { completed: number; total: number };
}

interface ExecutionsProps {
  /** Serve's live health snapshot: schedules and webhooks for the filters. */
  health?: HealthSnapshot | null;
  onOpenRun?: (workflowName: string, runId?: string) => void;
}

const PAGE_SIZE = 25;
const HISTORY_SLOTS = 12;

const COLUMNS: SkeletonColumn[] = [
  { header: "Run", cell: "mono" },
  { header: "Workflow" },
  { header: "Status", cell: "pill" },
  { header: "Started by", cell: 56 },
  { header: "Recent runs", cell: "strip" },
  { header: "Duration", cell: 48 },
  { header: "Steps", cell: 32 },
  { header: "Started", cell: 96 },
];

const STATUS_PARAM = oneOf<StatusValue>(["", ...RUN_STATUSES], "");
const SOURCE_PARAM = oneOf<RunSourceFilter>(["", ...RUN_SOURCES], "");

/** "in the last 7 days", "of all time", "between Oct 3 and Oct 9". */
function rangePhrase(range: TimeRange): string {
  if (range.kind === "preset" && range.preset === "all") return "yet";
  const text = describeTimeRange(range);
  return range.kind === "preset"
    ? `in the ${text.toLowerCase()}`
    : `between ${text.replace(" – ", " and ")}`;
}

export function Executions({ health, onOpenRun }: ExecutionsProps) {
  const catalog = useWorkflowCatalog(health ?? null);
  const [filter, setFilter] = useWorkflowFilter();
  const [status, setStatus] = useQueryState<StatusValue>(
    "status",
    "",
    STATUS_PARAM,
  );
  const [source, setSource] = useQueryState<RunSourceFilter>(
    "source",
    "",
    SOURCE_PARAM,
  );
  const { range } = useTimeRange();
  const searchWindow = runSearchWindow(range);

  // Runs are paged on the server, so the workflow filter becomes the exact
  // workflow names it selects. Until the catalog is in, a filter cannot be
  // resolved and nothing is requested.
  const workflowFilterActive = isFilterActive(filter);
  const resolvingFilter = workflowFilterActive && catalog.loading;
  const workflowNames = useMemo(
    () =>
      resolvingFilter
        ? null
        : workflowNamesForFilter(catalog.workflows, filter, catalog.facetsOf),
    [resolvingFilter, catalog.workflows, catalog.facetsOf, filter],
  );
  const matchesNoWorkflow = workflowNames !== null &&
    workflowNames.length === 0;
  // Past serve's cap on a `workflows` filter, rows are filtered here.
  const { server: serverNames, local: localNames } = useMemo(
    () => splitWorkflowFilter(workflowNames),
    [workflowNames],
  );
  const enabled = !resolvingFilter && !matchesNoWorkflow;

  // Any change to what is listed starts again at the first page. Keyed on
  // the chosen range, not its resolved bounds, which move every minute.
  const filterKey = JSON.stringify([workflowNames, status, source, range]);
  const [paging, setPaging] = useState({ key: filterKey, page: 0 });
  const page = paging.key === filterKey ? paging.page : 0;
  const setPage = useCallback(
    (next: number) => setPaging({ key: filterKey, page: next }),
    [filterKey],
  );

  const search = useRequest(
    "workflow.run.search",
    runSearchPayload({
      page,
      pageSize: PAGE_SIZE,
      status,
      source,
      workflows: serverNames,
      since: searchWindow.since,
      until: searchWindow.until,
    }),
    { enabled },
  );
  // A new page or filter keeps the rows on screen (dimmed) until the
  // reply lands, instead of flashing an empty table.
  const shown = useKeepPrevious(search.data, !enabled);
  const pageRuns = extractArray<RunItem>(shown);
  const runs = useMemo(
    () =>
      localNames
        ? pageRuns.filter((r) => localNames.has(r.workflowName))
        : pageRuns,
    [pageRuns, localNames],
  );
  const total = extractTotal(shown) ?? pageRuns.length;
  const refreshing = search.loading && shown !== null;

  // Totals for the header and the status counts: every status, the same
  // workflows, source and time range.
  const totalsQuery: RunSummaryQuery = {};
  if (serverNames !== null) totalsQuery.workflows = [...serverNames];
  if (source) totalsQuery.triggerSource = source;
  const totalsRequest = useRunSummary(totalsQuery, { enabled });
  const summary = useKeepPrevious(totalsRequest.summary, !enabled);
  const totals = summary
    ? localNames
      ? totalsOfWorkflows(summary.workflows, localNames)
      : summary.totals
    : null;

  // Recent runs of the workflows on this page, one strip per row.
  const pageWorkflows = useMemo(
    () => [...new Set(runs.map((r) => r.workflowName))].sort(),
    [runs],
  );
  const historyRequest = useRunSummary(
    { workflows: pageWorkflows, recentLimit: HISTORY_SLOTS },
    { enabled: pageWorkflows.length > 0 },
  );
  const history = summariesByName(useKeepPrevious(historyRequest.summary));
  // A serve without the run summary has no strips to show: drop the column.
  const showHistory = !historyRequest.error;
  const columns = showHistory
    ? COLUMNS
    : COLUMNS.filter((c) => c.header !== "Recent runs");

  // The seam for live updates: a stream of run events can call this (or
  // splice rows in) once serve pushes new executions.
  const refreshAll = useCallback(() => {
    search.refetch();
    totalsRequest.refetch();
    historyRequest.refetch();
  }, [search.refetch, totalsRequest.refetch, historyRequest.refetch]);

  const anyFilter = workflowFilterActive || status !== "" || source !== "";
  const clearAll = () => {
    setFilter(EMPTY_FILTER);
    setStatus("");
    setSource("");
  };

  const stats: Stat[] | null = totals
    ? [
      {
        label: "executions",
        value: formatCount(totals.runs),
      },
      {
        label: "passed",
        value: formatCount(totals.succeeded),
        tone: "success",
      },
      {
        label: "failed",
        value: formatCount(totals.failed),
        tone: totals.failed > 0 ? "danger" : "neutral",
      },
      {
        label: "running",
        value: formatCount(totals.running),
        tone: totals.running > 0 ? "running" : "neutral",
      },
      {
        label: "total time",
        value: formatDuration(totals.durationMs),
        title: "Summed duration of finished runs",
      },
    ]
    : null;

  const openRow = (e: MouseEvent<HTMLTableRowElement>, run: RunItem) => {
    // Links and buttons in the row handle their own clicks; a click on
    // selected text is a selection, not a navigation.
    if ((e.target as Element).closest("a, button")) return;
    if (globalThis.getSelection?.()?.toString()) return;
    onOpenRun?.(run.workflowName, run.runId);
  };

  let body;
  if (search.error && shown === null) {
    body = (
      <EmptyState
        title="Couldn't load executions"
        action={
          <button type="button" className="btn-sm" onClick={refreshAll}>
            Try again
          </button>
        }
      >
        {search.error}
      </EmptyState>
    );
  } else if (matchesNoWorkflow) {
    body = (
      <EmptyState
        title="No workflows match these filters"
        action={
          <button type="button" className="btn-sm" onClick={clearAll}>
            Clear filters
          </button>
        }
      >
        Executions are listed for the workflows the search and filters select.
      </EmptyState>
    );
  } else if (shown === null) {
    body = (
      <SkeletonTable
        columns={COLUMNS}
        rows={PAGE_SIZE / 2}
        label="Loading executions"
      />
    );
  } else if (runs.length === 0 && pageRuns.length > 0) {
    body = (
      <EmptyState title="No matching executions on this page">
        This filter selects too many workflows to send to serve, so it is
        applied to each page of runs here. Try the next page, or narrow the
        filter.
      </EmptyState>
    );
  } else if (runs.length === 0) {
    body = anyFilter
      ? (
        <EmptyState
          title="No executions match these filters"
          action={
            <button type="button" className="btn-sm" onClick={clearAll}>
              Clear filters
            </button>
          }
        >
          Nothing ran {rangePhrase(range)}{" "}
          that matches. Widen the time range or clear the filters.
        </EmptyState>
      )
      : (
        <EmptyState title={`No executions ${rangePhrase(range)}`}>
          Runs appear here as workflows start — on a schedule, from a webhook,
          or by hand.
        </EmptyState>
      );
  } else {
    body = (
      <div
        className={`table-wrap exec-table${refreshing ? " is-stale" : ""}`}
        aria-busy={refreshing}
      >
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.header} scope="col">{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const recent = history.get(run.workflowName)?.recent;
              return (
                <tr
                  key={run.runId}
                  className="exec-row"
                  onClick={(e) => openRow(e, run)}
                >
                  <td>
                    <RouteLink
                      className="mono exec-run-link"
                      title={`Run ${run.runId}`}
                      to={{
                        view: "workflows",
                        detail: {
                          kind: "run",
                          workflowName: run.workflowName,
                          runId: run.runId,
                        },
                      }}
                    >
                      {run.runId.slice(0, 8)}
                    </RouteLink>
                  </td>
                  <td className="exec-workflow">
                    <RouteLink
                      className="exec-workflow-link"
                      title={run.workflowName}
                      to={{
                        view: "workflows",
                        detail: {
                          kind: "workflow",
                          workflowName: run.workflowName,
                        },
                      }}
                    >
                      {run.workflowName}
                    </RouteLink>
                  </td>
                  <td>
                    <span className="exec-status">
                      <StatusPill status={run.status} />
                      {run.status === "failed" && (
                        <FailureLink
                          workflowName={run.workflowName}
                          runId={run.runId}
                        />
                      )}
                    </span>
                  </td>
                  <td>
                    <TriggerBadge trigger={run.triggerSource} />
                  </td>
                  {showHistory && (
                    <td className="exec-history">
                      {recent
                        ? (
                          <RunHistoryBar
                            runs={recent}
                            workflowName={run.workflowName}
                            slots={HISTORY_SLOTS}
                            height={12}
                            currentRunId={run.runId}
                            noun={`runs of ${run.workflowName}`}
                          />
                        )
                        : historyRequest.loading
                        ? (
                          <SkeletonRunHistory
                            slots={HISTORY_SLOTS}
                            height={12}
                          />
                        )
                        : null}
                    </td>
                  )}
                  <td className="mono exec-num">
                    {formatDuration(run.duration)}
                  </td>
                  <td className="mono exec-num exec-muted">
                    {run.stepProgress
                      ? `${run.stepProgress.completed}/${run.stepProgress.total}`
                      : "—"}
                  </td>
                  <td>
                    <time
                      className="exec-time"
                      dateTime={run.startedAt}
                      title={formatAbsoluteTime(run.startedAt)}
                    >
                      <span>{formatRelativeTime(run.startedAt)}</span>
                      <span className="exec-muted">
                        {formatShortDateTime(run.startedAt)}
                      </span>
                    </time>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="executions-page">
      <div className="page-header">
        <h1>Executions</h1>
        <div className="header-right">
          {stats
            ? <StatPills stats={stats} label="Executions summary" />
            : totalsRequest.loading || resolvingFilter
            ? <SkeletonPills count={5} />
            : shown !== null && (
              // A serve without the run summary still reports the total.
              <StatPills
                stats={[{ label: "executions", value: formatCount(total) }]}
                label="Executions summary"
              />
            )}
        </div>
      </div>

      <FilterBar
        filter={filter}
        onChange={setFilter}
        prefixes={catalog.prefixes}
        webhooks={catalog.webhookRoutes}
        placeholder="Search workflows"
        shown={workflowNames?.length}
        total={catalog.workflows.length}
        noun="workflows"
      >
        <FilterSelect<RunSourceFilter>
          label="Started by"
          value={source}
          onChange={setSource}
          options={[
            { value: "", label: "Anything" },
            ...RUN_SOURCES.map((s) => ({
              value: s,
              label: RUN_SOURCE_LABELS[s],
            })),
          ]}
        />
      </FilterBar>

      <div className="panel">
        <div className="exec-toolbar">
          <RunStatusFilter
            value={status}
            onChange={setStatus}
            counts={statusCounts(totals)}
          />
          <div className="exec-toolbar-right">
            {refreshing && (
              <span className="exec-updating" role="status">
                Updating…
              </span>
            )}
            <button
              type="button"
              className="btn-sm exec-refresh"
              onClick={refreshAll}
              disabled={!enabled || search.loading}
              aria-label="Refresh executions"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
                <path d="M13.5 2.5v3h-3" />
              </svg>
              Refresh
            </button>
          </div>
        </div>
        {refreshing && <div className="exec-progress" aria-hidden="true" />}
        {body}
        {localNames && pageRuns.length > 0 && (
          <p className="exec-local-note">
            Filtered on this page: the filter selects more than 1,000 workflows,
            so pages may hold fewer rows.
          </p>
        )}
        {pageRuns.length > 0 && !matchesNoWorkflow && (
          <Pager
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
