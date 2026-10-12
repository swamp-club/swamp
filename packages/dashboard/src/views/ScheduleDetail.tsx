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

import { useCallback, useEffect, useMemo, useState } from "react";
import type { HealthSnapshot } from "../client/useHealthStream";
import { healthViewState } from "../client/health_state";
import { useRequest } from "../client/useRequest";
import { extractObject } from "../client/extract";
import { HealthUnavailable } from "../components/HealthUnavailable";
import { EmptyState } from "../components/EmptyState.tsx";
import { RouteLink } from "../components/RouteLink.tsx";
import { RunHistoryBar, RunningBadge } from "../components/RunHistoryBar.tsx";
import {
  Skeleton,
  SkeletonPanel,
  SkeletonPills,
  SkeletonRunHistory,
  SkeletonTable,
} from "../components/Skeleton.tsx";
import { type Stat, StatPills } from "../components/StatPills.tsx";
import { ScheduleControls } from "../components/ScheduleControls.tsx";
import { TriggerFlow } from "../components/TriggerFlow.tsx";
import {
  RelativeTime,
  RUN_COLUMNS,
  SourceTag,
  TriggerRunsTable,
  workflowRoute,
} from "../components/TriggerTables.tsx";
import { flowJobsOf, type WorkflowJobDef } from "../components/trigger_flow.ts";
import {
  useRefetchOnChange,
  useTriggerRuns,
  useTriggerRunSummaries,
} from "../client/trigger_runs.ts";
import { useScheduleMutations } from "../client/schedule_mutations.ts";
import { describeTimeRange, useTimeRange } from "../client/time_range.ts";
import {
  describeCron,
  fireTimeLabels,
  nextFireTimes,
  parseCron,
} from "../lib/cron.ts";
import {
  averageDuration,
  inputRows,
  isDeniedCode,
  successRate,
  valueText,
} from "../lib/triggers.ts";
import {
  formatAbsoluteTime,
  formatCount,
  formatDuration,
  formatRelativeTime,
} from "../lib/format.ts";
import { scheduleQueueLabel } from "./schedule_queue.ts";
import { ScheduleEditDialog, type TriggerInfo } from "./ScheduleEditDialog.tsx";
import "../styles/triggers.css";

interface WorkflowDef {
  name: string;
  jobs?: WorkflowJobDef[];
}

const UPCOMING = 5;

export function ScheduleDetail(
  { workflowName, health, denied, onBack }: {
    workflowName: string;
    health: HealthSnapshot | null;
    denied: boolean;
    onBack: () => void;
  },
) {
  const healthState = healthViewState(health, denied);
  const entry = health?.scheduling?.schedules.find((s) =>
    s.workflowName === workflowName
  );
  const trigger = useRequest("workflow.trigger.get", { workflowName });
  const info = trigger.error ? null : extractObject<TriggerInfo>(trigger.data);
  const wf = useRequest("workflow.get", { workflowIdOrName: workflowName });
  const workflow = wf.error ? null : extractObject<WorkflowDef>(wf.data);
  const runs = useTriggerRuns("schedule", workflowName);
  // Exact counts over the whole time range; `runs` is only the newest page.
  const names = useMemo(() => [workflowName], [workflowName]);
  const summary = useTriggerRunSummaries("schedule", names, {
    recentLimit: 0,
  });
  const { range } = useTimeRange();

  const { refetch: refetchTrigger } = trigger;
  const mutations = useScheduleMutations(refetchTrigger);
  const { sync } = mutations;
  useEffect(() => {
    if (entry) sync([entry]);
  }, [entry, sync]);
  const { refetch: refetchRuns } = runs;
  const { refetch: refetchSummary } = summary;
  const refetchAll = useCallback(() => {
    refetchRuns();
    refetchSummary();
  }, [refetchRuns, refetchSummary]);
  useRefetchOnChange(
    entry ? `${entry.nextRun}:${entry.running}` : "",
    refetchAll,
  );
  const [editing, setEditing] = useState(false);

  const paused = mutations.pausedOf(
    workflowName,
    entry?.paused ?? info?.effective.paused,
  );
  const cron = entry?.cronExpression ?? info?.effective.schedule ?? null;
  const description = cron ? describeCron(cron) : null;
  const hasOverride = Boolean(
    info?.override &&
      (info.override.schedule !== undefined ||
        info.override.inputs !== undefined),
  );
  const source = entry?.source ??
    (info ? (hasOverride ? "override" : "workflow") : undefined);
  const now = Date.now();
  // Recomputed when the schedule fires (its next run moves), not per render.
  const firedAt = entry?.nextRun;
  // Serve's scheduler reads the expression in its own time zone.
  const serveZone = health?.scheduling?.timeZone;
  const upcoming = useMemo(() => {
    if (!cron || paused) return [];
    const parsed = parseCron(cron);
    return parsed.ok
      ? nextFireTimes(parsed.schedule, new Date(), UPCOMING, {
        timeZone: serveZone,
      })
      : [];
  }, [cron, paused, firedAt, serveZone]);

  const counts = summary.totals;
  const runningCount = runs.runs.filter((r) => r.status === "running").length;
  const rangeLabel = describeTimeRange(range);
  const stats: Stat[] = [
    {
      label: "scheduled runs",
      value: formatCount(counts.runs),
      title: rangeLabel,
    },
    {
      label: "succeeded",
      value: formatCount(counts.succeeded),
      tone: "success",
    },
    {
      label: "failed",
      value: formatCount(counts.failed),
      tone: counts.failed > 0 ? "danger" : "neutral",
    },
    { label: "success rate", value: successRate(counts) },
    { label: "avg duration", value: formatDuration(averageDuration(counts)) },
  ];

  const loadingSchedule = (healthState === "loading" && !info) ||
    (healthState !== "loading" && !entry && !info && !trigger.error);
  const missing = !loadingSchedule && !entry && !info?.effective.schedule;

  const flowInputs = info
    ? Object.entries(info.effective.inputs ?? {}).map(([k, v]) =>
      `${k} = ${valueText(v)}`
    )
    : [];
  const inputs = info
    ? inputRows(
      info.effective.inputs,
      info.builtIn?.inputs,
      info.override?.inputs,
    )
    : [];

  return (
    <>
      <div className="page-header">
        <div className="trig-title">
          <button type="button" className="back-button" onClick={onBack}>
            &larr; Back
          </button>
          <h1>{workflowName}</h1>
          {entry?.running && <RunningBadge count={Math.max(1, runningCount)} />}
          {paused && <span className="trig-pill tone-warning">Paused</span>}
        </div>
        {!missing && cron && (
          <ScheduleControls
            workflowName={workflowName}
            paused={entry?.paused !== undefined ||
                info?.effective.paused !== undefined
              ? paused
              : undefined}
            canReset={hasOverride || source === "override"}
            pending={mutations.pending.get(workflowName)}
            feedback={mutations.feedback.get(workflowName)}
            onPause={() => void mutations.setPaused(workflowName, true)}
            onResume={() => void mutations.setPaused(workflowName, false)}
            onEdit={() => setEditing(true)}
            onReset={() => void mutations.reset(workflowName, paused === true)}
            layout="header"
          />
        )}
      </div>
      <div className="trig-subtitle">
        <span>Schedule of</span>
        <RouteLink to={workflowRoute(workflowName)}>
          workflow {workflowName}
        </RouteLink>
      </div>

      {healthState === "denied" && !info && (
        <HealthUnavailable state="denied" subject="this schedule" />
      )}

      {missing
        ? (
          <div className="panel">
            <EmptyState
              title="No schedule"
              action={
                <RouteLink to={{ view: "schedules", detail: null }}>
                  All schedules
                </RouteLink>
              }
            >
              {trigger.error && isDeniedCode(trigger.errorInfo?.code)
                ? `You don't have permission to read the schedule of ${workflowName}.`
                : `${workflowName} has no schedule on this serve.`}
            </EmptyState>
          </div>
        )
        : (
          <div className="trig-detail">
            {summary.loading
              ? <SkeletonPills count={5} />
              : <StatPills stats={stats} label="Scheduled runs summary" />}

            <div className="trig-grid">
              {loadingSchedule
                ? (
                  <SkeletonPanel
                    title="Schedule"
                    label="Loading schedule"
                    rows={4}
                  />
                )
                : (
                  <div className="panel">
                    <div className="panel-header">
                      <div className="panel-title">Schedule</div>
                    </div>
                    <dl className="trig-kv">
                      <dt>Expression</dt>
                      <dd>
                        <span className="cron-badge">{cron}</span>
                        <span className="trig-sub">
                          {description ?? "Custom schedule"}
                        </span>
                      </dd>
                      <dt>Next run</dt>
                      <dd>
                        {paused
                          ? (
                            <span className="trig-paused-text">
                              Paused — no new runs until resumed
                            </span>
                          )
                          : entry?.nextRun
                          ? (
                            <>
                              <RelativeTime iso={entry.nextRun} now={now} />
                              <span className="trig-sub">
                                {formatAbsoluteTime(entry.nextRun)}
                              </span>
                            </>
                          )
                          : "—"}
                      </dd>
                      <dt>Source</dt>
                      <dd>
                        <SourceTag source={source} />
                        {info?.builtIn?.schedule && source === "override" && (
                          <span className="trig-sub">
                            Workflow file:{" "}
                            <span className="mono">
                              {info.builtIn.schedule}
                            </span>
                          </span>
                        )}
                      </dd>
                      {entry && (entry.queued ?? 0) > 0 && (
                        <>
                          <dt>Queue</dt>
                          <dd>{scheduleQueueLabel(entry, now)}</dd>
                        </>
                      )}
                      {entry?.lastQueueDelayMs != null && (
                        <>
                          <dt>Last start delay</dt>
                          <dd>{formatDuration(entry.lastQueueDelayMs)}</dd>
                        </>
                      )}
                    </dl>
                    {upcoming.length > 0 && (
                      <>
                        <div className="trig-fire-head">
                          Upcoming · {serveZone
                            ? `serve's time zone (${serveZone})`
                            : "your time zone"}
                        </div>
                        <ol className="trig-fire-list">
                          {upcoming.map((d) => {
                            const label = fireTimeLabels(d, serveZone);
                            return (
                              <li key={d.getTime()}>
                                <div>
                                  <time
                                    dateTime={d.toISOString()}
                                    title={formatAbsoluteTime(d)}
                                  >
                                    {label.primary}
                                  </time>
                                  {label.local && (
                                    <small className="fire-local">
                                      {label.local} your time
                                    </small>
                                  )}
                                </div>
                                <span>{formatRelativeTime(d, now)}</span>
                              </li>
                            );
                          })}
                        </ol>
                      </>
                    )}
                  </div>
                )}

              {!info && !trigger.error
                ? (
                  <SkeletonPanel
                    title="Inputs"
                    label="Loading inputs"
                    rows={3}
                  />
                )
                : (
                  <div className="panel">
                    <div className="panel-header">
                      <div className="panel-title">
                        Inputs
                        <span className="panel-count">{inputs.length}</span>
                      </div>
                    </div>
                    {trigger.error
                      ? (
                        <div className="trig-panel-note" role="status">
                          {isDeniedCode(trigger.errorInfo?.code)
                            ? "You don't have permission to read this schedule's inputs."
                            : `Inputs couldn't be loaded: ${trigger.error}`}
                        </div>
                      )
                      : inputs.length === 0
                      ? (
                        <EmptyState title="No inputs">
                          Scheduled runs start with the workflow's defaults.
                        </EmptyState>
                      )
                      : (
                        <div className="table-wrap">
                          <table className="data-table trig-inputs-table">
                            <thead>
                              <tr>
                                <th scope="col">Input</th>
                                <th scope="col">Effective</th>
                                <th scope="col">Workflow file</th>
                                <th scope="col">Override</th>
                              </tr>
                            </thead>
                            <tbody>
                              {inputs.map((row) => (
                                <tr key={row.key}>
                                  <td className="mono">{row.key}</td>
                                  <td className="is-effective">
                                    <span className="mono">
                                      {valueText(row.effective)}
                                    </span>
                                    <span className="trig-origin">
                                      {row.origin === "override"
                                        ? "override"
                                        : row.origin === "workflow"
                                        ? "file"
                                        : ""}
                                    </span>
                                  </td>
                                  <td className="mono trig-muted">
                                    {valueText(row.builtIn)}
                                  </td>
                                  <td className="mono">
                                    {valueText(row.override)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                  </div>
                )}
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Flow</div>
              </div>
              {(!workflow && !wf.error) || (!cron && loadingSchedule)
                ? (
                  <div className="trig-section-body">
                    <Skeleton height={96} radius={8} />
                  </div>
                )
                : (
                  <TriggerFlow
                    spec={{
                      trigger: {
                        kind: "schedule",
                        title: cron ?? "Schedule",
                        lines: [
                          paused ? "Paused" : description ?? "Custom schedule",
                        ],
                        paused,
                      },
                      inputs: info ? flowInputs : null,
                      inputsTitle: "Inputs",
                      workflowName,
                      jobs: flowJobsOf(workflow?.jobs),
                    }}
                  />
                )}
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">
                  Scheduled runs
                  {!runs.loading && (
                    <span className="panel-count">
                      {formatCount(runs.total ?? runs.runs.length)}
                    </span>
                  )}
                </div>
                <span className="trig-muted" style={{ fontSize: "0.75rem" }}>
                  {rangeLabel}
                </span>
              </div>
              {runs.loading
                ? (
                  <>
                    <div className="trig-section-body">
                      <SkeletonRunHistory slots={50} height={18} />
                    </div>
                    <SkeletonTable
                      label="Loading scheduled runs"
                      rows={6}
                      columns={RUN_COLUMNS.map((header) => ({
                        header,
                        cell: header === "Status" ? "pill" : "mono",
                      }))}
                    />
                  </>
                )
                : runs.error
                ? (
                  <div className="trig-panel-note" role="status">
                    Scheduled runs couldn't be loaded: {runs.error}
                  </div>
                )
                : runs.runs.length === 0
                ? (
                  <EmptyState title="No scheduled runs in this range">
                    {paused
                      ? "This schedule is paused."
                      : `Nothing ran on this schedule · ${rangeLabel.toLowerCase()}.`}
                  </EmptyState>
                )
                : (
                  <>
                    <div className="trig-section-body">
                      <RunHistoryBar
                        runs={runs.runs}
                        workflowName={workflowName}
                        slots={50}
                        height={18}
                        noun="scheduled runs"
                      />
                    </div>
                    <TriggerRunsTable runs={runs.runs} now={now} />
                    {runs.total !== null && runs.total > runs.runs.length && (
                      <div className="trig-panel-note">
                        Showing the latest {formatCount(runs.runs.length)} of
                        {" "}
                        {formatCount(runs.total)} scheduled runs.
                      </div>
                    )}
                  </>
                )}
            </div>
          </div>
        )}

      {editing && (
        <ScheduleEditDialog
          workflowName={workflowName}
          mutations={mutations}
          onClose={() => setEditing(false)}
          timeZone={serveZone}
        />
      )}
    </>
  );
}
