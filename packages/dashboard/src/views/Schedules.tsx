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

import { applyRowFacets, type RowFacetSpec } from "../lib/row_facets.ts";
import { useEffect, useMemo, useState } from "react";
import type { HealthSnapshot, ScheduleEntry } from "../client/useHealthStream";
import { healthViewState } from "../client/health_state";
import { HealthUnavailable } from "../components/HealthUnavailable";
import { EmptyState } from "../components/EmptyState.tsx";
import { SkeletonPills, SkeletonTable } from "../components/Skeleton.tsx";
import { type Stat, StatPills } from "../components/StatPills.tsx";
import {
  rowSearchFacets,
  TriggerFilterBar,
} from "../components/TriggerFilterBar.tsx";
import { ScheduleControls } from "../components/ScheduleControls.tsx";
import {
  SCHEDULE_COLUMNS,
  scheduleRoute,
  type ScheduleRow,
  ScheduleTable,
} from "../components/TriggerTables.tsx";
import { navigateTo } from "../hooks/useRouter.ts";
import {
  asString,
  useFacetParams,
  useQueryState,
} from "../client/useQueryState.ts";
import {
  useRefetchOnChange,
  useTriggerRunSummaries,
} from "../client/trigger_runs.ts";
import {
  type ScheduleMutations,
  useScheduleMutations,
} from "../client/schedule_mutations.ts";
import { describeTimeRange, useTimeRange } from "../client/time_range.ts";
import { describeCron } from "../lib/cron.ts";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import { workflowPrefix } from "../lib/workflow_facets.ts";
import { formatCount } from "../lib/format.ts";
import { scheduleQueueLabel } from "./schedule_queue.ts";
import { ScheduleEditDialog } from "./ScheduleEditDialog.tsx";
import "../styles/triggers.css";

const LAST_RUN_LABELS: Record<string, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  suspended: "Suspended",
  cancelled: "Cancelled",
  never: "No runs in range",
};

/** What the schedule table can be filtered by, beyond free text. */
const SCHEDULE_FACETS: readonly RowFacetSpec<ScheduleRow>[] = [
  {
    key: "state",
    label: "State",
    description: "Active or paused schedules",
    valueOf: (r) => (r.paused === true ? "paused" : "active"),
    labelOf: (v) => (v === "paused" ? "Paused" : "Active"),
    order: ["active", "paused"],
  },
  {
    key: "activity",
    label: "Activity",
    description: "Running now, waiting in the queue, or idle",
    valueOf: (r) => (r.running ? "running" : r.queueLabel ? "queued" : "idle"),
    labelOf: (v) =>
      v === "running" ? "Running now" : v === "queued" ? "Queued" : "Idle",
    order: ["running", "queued", "idle"],
  },
  {
    key: "last",
    label: "Last run",
    description: "How the latest scheduled run in range ended",
    valueOf: (r) => r.recent[0]?.status ?? "never",
    labelOf: (v) => LAST_RUN_LABELS[v] ?? v,
    order: Object.keys(LAST_RUN_LABELS),
  },
  {
    key: "prefix",
    label: "Prefix",
    description: "Schedules whose workflow name starts with a prefix",
    valueOf: (r) => workflowPrefix(r.workflowName),
  },
  {
    key: "source",
    label: "Source",
    description: "Schedule from the workflow file, or a serve override",
    valueOf: (r) => r.source ?? null,
    labelOf: (v) => (v === "override" ? "Override" : "Workflow file"),
  },
];
const SCHEDULE_FACET_KEYS = SCHEDULE_FACETS.map((f) => f.key);

/** The pause state the page shows: unconfirmed changes win. */
function pausedOf(entry: ScheduleEntry, mutations: ScheduleMutations) {
  return mutations.pausedOf(entry.workflowName, entry.paused);
}

export function Schedules(
  { health, denied }: { health: HealthSnapshot | null; denied: boolean },
) {
  const state = healthViewState(health, denied);
  const schedules = useMemo(
    () =>
      [...(health?.scheduling?.schedules ?? [])].sort((a, b) =>
        a.workflowName.localeCompare(b.workflowName)
      ),
    [health],
  );
  const names = useMemo(() => schedules.map((s) => s.workflowName), [
    schedules,
  ]);
  const runs = useTriggerRunSummaries("schedule", names, {
    enabled: state === "ready",
  });
  const fireKey = schedules
    .map((s) => `${s.workflowName}:${s.nextRun}:${s.running}`)
    .join("|");
  useRefetchOnChange(fireKey, runs.refetch);

  const mutations = useScheduleMutations();
  const { sync } = mutations;
  useEffect(() => sync(schedules), [schedules, sync]);

  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useQueryState("q", "", asString);
  const [selected, select] = useFacetParams(SCHEDULE_FACET_KEYS);
  const { range } = useTimeRange();
  const now = Date.now();

  const rows: ScheduleRow[] = schedules.map((s) => {
    const summary = runs.byWorkflow.get(s.workflowName);
    return {
      workflowName: s.workflowName,
      cron: s.cronExpression,
      description: describeCron(s.cronExpression),
      nextRun: s.nextRun,
      paused: pausedOf(s, mutations),
      source: s.source,
      running: s.running,
      runningCount: summary?.running ?? 0,
      queueLabel: scheduleQueueLabel(s, now),
      recent: summary?.recent ?? [],
    };
  });

  const filtered = fuzzyFilter(
    applyRowFacets(rows, SCHEDULE_FACETS, selected),
    query,
    (r) => [r.workflowName, r.cron, r.description ?? ""],
  );
  const facets = rowSearchFacets(rows, SCHEDULE_FACETS, selected, select);
  const clearFilters = () => {
    setQuery("");
    for (const key of SCHEDULE_FACET_KEYS) select(key, []);
  };

  const pausedCount = rows.filter((r) => r.paused === true).length;
  const runningCount = rows.filter((r) => r.running).length;
  const rangeLabel = describeTimeRange(range);
  const stats: Stat[] = [
    { label: "schedules", value: formatCount(rows.length) },
    {
      label: "active",
      value: formatCount(rows.length - pausedCount),
      tone: "success",
    },
    {
      label: "paused",
      value: formatCount(pausedCount),
      tone: pausedCount > 0 ? "warning" : "neutral",
    },
    {
      label: "running now",
      value: formatCount(runningCount),
      tone: runningCount > 0 ? "running" : "neutral",
    },
    {
      label: "failed scheduled runs",
      value: runs.loading ? "…" : formatCount(runs.totals.failed),
      tone: runs.totals.failed > 0 ? "danger" : "neutral",
      title: `Scheduled runs that failed · ${rangeLabel}`,
    },
  ];

  return (
    <>
      <div className="page-header">
        <h1>Schedules</h1>
        <div className="header-right">
          {state === "ready"
            ? <StatPills stats={stats} label="Schedule summary" />
            : state === "loading"
            ? <SkeletonPills count={5} />
            : null}
        </div>
      </div>

      {state === "ready" && health?.scheduling?.enabled === false && (
        <div className="notice notice-warning trig-notice" role="status">
          Scheduling is turned off on this serve, so these schedules won't fire
          until it is enabled.
        </div>
      )}

      {state === "ready" && rows.length > 0 && (
        <TriggerFilterBar
          query={query}
          onQuery={setQuery}
          placeholder="Search schedules, or filter by state, last run, prefix…"
          facets={facets}
          shown={filtered.length}
          total={rows.length}
          noun="schedules"
          onClear={clearFilters}
        />
      )}

      <div className="panel">
        {state === "denied"
          ? <HealthUnavailable state={state} subject="schedules" />
          : state === "loading"
          ? (
            <SkeletonTable
              label="Loading schedules"
              rows={8}
              columns={SCHEDULE_COLUMNS.map((header) => ({
                header,
                cell: header === "Scheduled runs"
                  ? "strip"
                  : header === "Schedule" || header === "State"
                  ? "pill"
                  : header === "Next run" || header === "Last run"
                  ? "mono"
                  : undefined,
              }))}
            />
          )
          : rows.length === 0
          ? (
            <EmptyState title="No schedules">
              No workflow visible to this token has a schedule. Add a{" "}
              <code>trigger.schedule</code> to a workflow, or set one with{" "}
              <code>swamp workflow trigger set</code>.
            </EmptyState>
          )
          : filtered.length === 0
          ? (
            <EmptyState
              title="No schedules match"
              action={
                <button
                  type="button"
                  className="trig-btn"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              }
            >
              Nothing matches the current search and filters.
            </EmptyState>
          )
          : (
            <ScheduleTable
              rows={filtered}
              runsLoading={runs.loading}
              now={now}
              onOpen={(name) => navigateTo(scheduleRoute(name))}
              renderControls={(row) => (
                <ScheduleControls
                  workflowName={row.workflowName}
                  paused={row.paused}
                  canReset={row.source === "override"}
                  pending={mutations.pending.get(row.workflowName)}
                  feedback={mutations.feedback.get(row.workflowName)}
                  onPause={() =>
                    void mutations.setPaused(row.workflowName, true)}
                  onResume={() =>
                    void mutations.setPaused(row.workflowName, false)}
                  onEdit={() => setEditing(row.workflowName)}
                  onReset={() =>
                    void mutations.reset(row.workflowName, row.paused === true)}
                />
              )}
            />
          )}
        {state === "ready" && runs.error && (
          <div className="trig-panel-note" role="status">
            Run history couldn't be loaded: {runs.error}
          </div>
        )}
      </div>

      {editing !== null && (
        <ScheduleEditDialog
          workflowName={editing}
          mutations={mutations}
          timeZone={health?.scheduling?.timeZone}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
