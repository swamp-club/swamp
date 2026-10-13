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

import { useMemo, useState } from "react";
import type { HealthSnapshot } from "../client/useHealthStream";
import { healthViewState } from "../client/health_state";
import { useRequest } from "../client/useRequest";
import { extractObject } from "../client/extract";
import { HealthUnavailable } from "../components/HealthUnavailable";
import { EmptyState } from "../components/EmptyState.tsx";
import { RouteLink } from "../components/RouteLink.tsx";
import { RunHistoryBar } from "../components/RunHistoryBar.tsx";
import {
  Skeleton,
  SkeletonPanel,
  SkeletonPills,
  SkeletonRunHistory,
  SkeletonTable,
} from "../components/Skeleton.tsx";
import { type Stat, StatPills } from "../components/StatPills.tsx";
import { TriggerFlow } from "../components/TriggerFlow.tsx";
import { RunCompare } from "../components/RunCompare.tsx";
import {
  RelativeTime,
  RUN_COLUMNS,
  TriggerRunsTable,
  webhookRoute,
  workflowRoute,
} from "../components/TriggerTables.tsx";
import { flowJobsOf, type WorkflowJobDef } from "../components/trigger_flow.ts";
import {
  useTriggerRuns,
  useTriggerRunSummaries,
} from "../client/trigger_runs.ts";
import { describeTimeRange, useTimeRange } from "../client/time_range.ts";
import {
  averageDuration,
  compareRuns,
  type RunDetailJob,
  successRate,
  toggleCompare,
} from "../lib/triggers.ts";
import { formatCount, formatDuration } from "../lib/format.ts";
import { useResolvedWebhooks } from "./Webhooks.tsx";
import "../styles/triggers.css";

interface WorkflowDef {
  name: string;
  jobs?: WorkflowJobDef[];
}

/** One run's jobs and steps, as `workflow.history.get` returns them. */
function useRunJobs(runId: string | undefined) {
  const { data, error } = useRequest(
    "workflow.history.get",
    { workflowIdOrName: runId ?? "" },
    { enabled: runId !== undefined },
  );
  const run = error ? null : extractObject<{ jobs?: RunDetailJob[] }>(data);
  return {
    jobs: run?.jobs ?? null,
    loading: runId !== undefined && data === null && error === null,
  };
}

export function WebhookDetail(
  { route, health, denied, onBack }: {
    route: string;
    health: HealthSnapshot | null;
    denied: boolean;
    onBack: () => void;
  },
) {
  const healthState = healthViewState(health, denied);
  const resolved = useResolvedWebhooks(health);
  const entry = resolved.find((w) => w.route === route);
  const workflowName = entry?.workflowName ?? "";
  const sharedWith = resolved
    .filter((w) => w.workflowName === workflowName && w.route !== route)
    .map((w) => w.route)
    .sort();

  const wf = useRequest("workflow.get", { workflowIdOrName: workflowName }, {
    enabled: entry !== undefined,
  });
  const workflow = wf.error ? null : extractObject<WorkflowDef>(wf.data);
  const runs = useTriggerRuns("webhook", workflowName, {
    enabled: entry !== undefined,
  });
  // Exact counts over the whole time range; `runs` is only the newest page.
  const names = useMemo(() => [workflowName], [workflowName]);
  const summary = useTriggerRunSummaries("webhook", names, {
    enabled: entry !== undefined,
    recentLimit: 0,
  });
  const { range } = useTimeRange();
  const rangeLabel = describeTimeRange(range);
  const now = Date.now();

  const [selected, setSelected] = useState<string[]>([]);
  // A is the earlier run, so deltas read as "B took longer/shorter".
  const picked = runs.runs
    .filter((r) => selected.includes(r.runId))
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const [runA, runB] = picked.length === 2 ? picked : [undefined, undefined];
  const jobsA = useRunJobs(runA?.runId);
  const jobsB = useRunJobs(runB?.runId);
  const compareRows = useMemo(
    () =>
      runA && runB
        ? compareRuns(
          { run: runA, jobs: jobsA.jobs },
          { run: runB, jobs: jobsB.jobs },
        )
        : [],
    [runA, runB, jobsA.jobs, jobsB.jobs],
  );

  const counts = summary.totals;
  const stats: Stat[] = [
    {
      label: "webhook runs",
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

  const header = (
    <>
      <div className="page-header">
        <div className="trig-title">
          <button type="button" className="back-button" onClick={onBack}>
            &larr; Back
          </button>
          <h1 className="mono">{route}</h1>
          {entry?.scheme && <span className="trig-pill">{entry.scheme}</span>}
        </div>
      </div>
      {entry && (
        <div className="trig-subtitle">
          <span>Webhook starting</span>
          <RouteLink to={workflowRoute(workflowName)}>
            workflow {workflowName}
          </RouteLink>
        </div>
      )}
    </>
  );

  if (healthState !== "ready") {
    return (
      <>
        {header}
        {healthState === "denied"
          ? <HealthUnavailable state="denied" subject="this webhook" />
          : (
            <div className="trig-detail">
              <SkeletonPills count={5} />
              <div className="trig-grid">
                <SkeletonPanel
                  title="Endpoint"
                  label="Loading webhook"
                  rows={3}
                />
                <SkeletonPanel title="Flow" label="Loading flow" rows={2} />
              </div>
            </div>
          )}
      </>
    );
  }

  if (!entry) {
    return (
      <>
        {header}
        <div className="panel">
          <EmptyState
            title="No such webhook"
            action={
              <RouteLink to={{ view: "webhooks", detail: null }}>
                All webhooks
              </RouteLink>
            }
          >
            This serve has no webhook route {route} visible to this token.
          </EmptyState>
        </div>
      </>
    );
  }

  const sharedNote = sharedWith.length > 0 && (
    <div className="trig-shared-note" role="note">
      <span aria-hidden="true">ⓘ</span>
      <span>
        Webhook runs of {workflowName} (shared by {sharedWith.length + 1}{" "}
        routes). Runs don't record which route started them, so this history
        also includes runs from {sharedWith.map((r, i) => (
          <span key={r}>
            {i > 0 && ", "}
            <RouteLink to={webhookRoute(r)} className="mono">{r}</RouteLink>
          </span>
        ))}.
      </span>
    </div>
  );

  return (
    <>
      {header}
      <div className="trig-detail">
        {summary.loading
          ? <SkeletonPills count={5} />
          : <StatPills stats={stats} label="Webhook runs summary" />}

        <div className="trig-detail">
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">Endpoint</div>
            </div>
            <dl className="trig-kv">
              <dt>Route</dt>
              <dd className="mono">{route}</dd>
              <dt>Method</dt>
              <dd className="mono">POST</dd>
              <dt>Workflow</dt>
              <dd>
                <RouteLink to={workflowRoute(workflowName)}>
                  {workflowName}
                </RouteLink>
                {entry.workflow !== workflowName && (
                  <span className="trig-sub">
                    Configured as <span className="mono">{entry.workflow}</span>
                  </span>
                )}
              </dd>
              <dt>Verification</dt>
              <dd>
                {entry.scheme
                  ? (
                    <>
                      <span className="trig-pill tone-success">
                        {entry.scheme}
                      </span>
                      <span className="trig-sub">
                        Requests must carry a valid signature.
                      </span>
                    </>
                  )
                  : (
                    <span className="trig-muted">
                      Not reported by this serve
                    </span>
                  )}
              </dd>
              {sharedWith.length > 0 && (
                <>
                  <dt>Also started by</dt>
                  <dd>
                    {sharedWith.map((r) => (
                      <RouteLink
                        key={r}
                        to={webhookRoute(r)}
                        className="mono"
                        style={{ display: "block" }}
                      >
                        {r}
                      </RouteLink>
                    ))}
                  </dd>
                </>
              )}
              <dt>Last run</dt>
              <dd>
                {runs.loading
                  ? <Skeleton width={90} height={10} />
                  : runs.runs[0]?.startedAt
                  ? <RelativeTime iso={runs.runs[0].startedAt} now={now} />
                  : <span className="trig-muted">None in range</span>}
              </dd>
            </dl>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">Flow</div>
            </div>
            {!workflow && !wf.error
              ? (
                <div className="trig-section-body">
                  <Skeleton height={96} radius={8} />
                </div>
              )
              : (
                <TriggerFlow
                  spec={{
                    trigger: {
                      kind: "webhook",
                      title: route,
                      lines: [
                        entry.scheme ? `POST · ${entry.scheme}` : "POST",
                      ],
                    },
                    inputs: ["request body", "request headers"],
                    inputsTitle: "Payload",
                    workflowName,
                    jobs: flowJobsOf(workflow?.jobs),
                  }}
                />
              )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              Webhook runs
              {!runs.loading && (
                <span className="panel-count">
                  {formatCount(runs.total ?? runs.runs.length)}
                </span>
              )}
            </div>
            <span className="trig-muted" style={{ fontSize: "0.75rem" }}>
              {selected.length === 1
                ? "Tick one more run to compare · "
                : runs.runs.length > 1 && selected.length === 0
                ? "Tick two runs to compare them · "
                : ""}
              {rangeLabel}
            </span>
          </div>
          {sharedNote}
          {runs.loading
            ? (
              <>
                <div className="trig-section-body">
                  <SkeletonRunHistory slots={50} height={18} />
                </div>
                <SkeletonTable
                  label="Loading webhook runs"
                  rows={6}
                  columns={["", ...RUN_COLUMNS].map((header) => ({
                    header,
                    cell: header === ""
                      ? 14
                      : header === "Status"
                      ? "pill"
                      : "mono",
                  }))}
                />
              </>
            )
            : runs.error
            ? (
              <div className="trig-panel-note" role="status">
                Webhook runs couldn't be loaded: {runs.error}
              </div>
            )
            : runs.runs.length === 0
            ? (
              <EmptyState title="No webhook runs in this range">
                Nothing called this webhook · {rangeLabel.toLowerCase()}.
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
                    noun="webhook runs"
                  />
                </div>
                {runA && runB && (
                  <RunCompare
                    a={runA}
                    b={runB}
                    rows={compareRows}
                    stepsLoading={jobsA.loading || jobsB.loading}
                    onClear={() => setSelected([])}
                  />
                )}
                <TriggerRunsTable
                  runs={runs.runs}
                  now={now}
                  selected={selected}
                  onToggleSelect={(id) =>
                    setSelected((s) => toggleCompare(s, id))}
                />
                {runs.total !== null && runs.total > runs.runs.length && (
                  <div className="trig-panel-note">
                    Showing the latest {formatCount(runs.runs.length)} of{" "}
                    {formatCount(runs.total)} webhook runs.
                  </div>
                )}
              </>
            )}
        </div>
      </div>
    </>
  );
}
