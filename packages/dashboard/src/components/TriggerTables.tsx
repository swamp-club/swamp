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

/** @jsxRuntime automatic */
/** @jsxImportSource react */

// The Schedules and Webhooks tables, and the run list on their detail
// pages. Presentational: views pass in rows and controls.

import type { ReactNode } from "react";
import { RouteLink } from "./RouteLink.tsx";
import { RunHistoryBar, RunningBadge } from "./RunHistoryBar.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { SkeletonRunHistory } from "./Skeleton.tsx";
import type { RouteState } from "../routes.ts";
import type { RecentRun, TriggerRun } from "../lib/triggers.ts";
import {
  formatAbsoluteTime,
  formatCount,
  formatDuration,
  formatRelativeTime,
} from "../lib/format.ts";

export const scheduleRoute = (workflowName: string): RouteState => ({
  view: "schedules",
  detail: { kind: "schedule", workflowName },
});

export const webhookRoute = (route: string): RouteState => ({
  view: "webhooks",
  detail: { kind: "webhook", route },
});

export const workflowRoute = (workflowName: string): RouteState => ({
  view: "workflows",
  detail: { kind: "workflow", workflowName },
});

export const runRoute = (workflowName: string, runId: string): RouteState => ({
  view: "workflows",
  detail: { kind: "run", workflowName, runId },
});

/**
 * Row clicks open the row, unless they landed on a control inside it or
 * finished a text selection. Loosely typed DOM access keeps this module
 * free of the DOM library, so it renders in tests.
 */
function rowClick(open: () => void) {
  return (e: { target: unknown }) => {
    const target = e.target as {
      closest?: (selector: string) => unknown;
    };
    if (target.closest?.("a, button, input, select, textarea, label")) return;
    const selection = (globalThis as {
      getSelection?: () => { toString: () => string } | null;
    }).getSelection?.();
    if (selection && selection.toString() !== "") return;
    open();
  };
}

/** A time as "5m ago" with the exact time on hover. */
export function RelativeTime(
  { iso, now }: { iso: string; now?: number },
) {
  return (
    <time dateTime={iso} title={formatAbsoluteTime(iso)}>
      {formatRelativeTime(iso, now)}
    </time>
  );
}

function LastRun(
  { run, now }: { run: RecentRun | undefined; now?: number },
) {
  if (!run) return <span className="trig-muted">None in range</span>;
  return (
    <span className="trig-last-run">
      <StatusPill status={run.status} />
      {run.startedAt && <RelativeTime iso={run.startedAt} now={now} />}
    </span>
  );
}

// ── Schedules ───────────────────────────────────────────────────────────

export interface ScheduleRow {
  workflowName: string;
  cron: string;
  description: string | null;
  nextRun: string | null;
  paused?: boolean;
  source?: "workflow" | "override";
  running: boolean;
  /** Scheduled runs in progress, when known; at least 1 while running. */
  runningCount: number;
  queueLabel: string | null;
  recent: RecentRun[];
}

export const SCHEDULE_COLUMNS = [
  "Workflow",
  "Schedule",
  "Next run",
  "Scheduled runs",
  "Last run",
  "State",
  "Actions",
] as const;

export function ScheduleTable(
  { rows, runsLoading, now, renderControls, onOpen }: {
    rows: ScheduleRow[];
    runsLoading: boolean;
    now?: number;
    renderControls: (row: ScheduleRow) => ReactNode;
    onOpen: (workflowName: string) => void;
  },
) {
  return (
    <div className="table-wrap">
      <table className="data-table trig-table">
        <thead>
          <tr>
            {SCHEDULE_COLUMNS.map((c) => <th key={c} scope="col">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.workflowName}
              className={`trig-row${row.paused ? " is-paused" : ""}`}
              onClick={rowClick(() => onOpen(row.workflowName))}
            >
              <td className="trig-name">
                <RouteLink to={scheduleRoute(row.workflowName)}>
                  {row.workflowName}
                </RouteLink>
              </td>
              <td>
                <span className="trig-cron">
                  <span className="cron-badge">{row.cron}</span>
                  {row.description && (
                    <span className="trig-cron-desc">{row.description}</span>
                  )}
                  {
                    // The workflow file is the norm; only flag an override.
                    row.source === "override" && (
                      <SourceTag source={row.source} />
                    )
                  }
                </span>
              </td>
              <td>
                {row.paused
                  ? <span className="trig-paused-text">Paused</span>
                  : row.nextRun
                  ? <RelativeTime iso={row.nextRun} now={now} />
                  : <span className="trig-muted">—</span>}
              </td>
              <td className="trig-pips">
                {runsLoading
                  ? <SkeletonRunHistory slots={20} height={14} />
                  : (
                    <RunHistoryBar
                      runs={row.recent}
                      workflowName={row.workflowName}
                      slots={20}
                      noun="scheduled runs"
                    />
                  )}
              </td>
              <td>
                {runsLoading
                  ? <span className="trig-muted">…</span>
                  : <LastRun run={row.recent[0]} now={now} />}
              </td>
              <td>
                <span className="trig-state">
                  {row.running
                    ? <RunningBadge count={Math.max(1, row.runningCount)} />
                    : row.paused
                    ? <span className="trig-pill tone-warning">Paused</span>
                    : row.queueLabel
                    ? <span className="trig-pill tone-info">Queued</span>
                    : <span className="trig-pill">Idle</span>}
                  {row.queueLabel && (
                    <span className="trig-queue">{row.queueLabel}</span>
                  )}
                </span>
              </td>
              <td className="trig-actions-cell">{renderControls(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SourceTag(
  { source }: { source?: "workflow" | "override" },
) {
  if (source === "override") {
    return (
      <span
        className="trig-pill tone-info"
        title="Set on serve; overrides the workflow file"
      >
        Override
      </span>
    );
  }
  if (source === "workflow") {
    return (
      <span className="trig-pill" title="From the workflow file">
        Workflow file
      </span>
    );
  }
  return <span className="trig-muted">—</span>;
}

// ── Webhooks ────────────────────────────────────────────────────────────

export interface WebhookRow {
  route: string;
  workflowName: string;
  scheme?: string;
  /** Other routes that start the same workflow. */
  sharedWith: string[];
  recent: RecentRun[];
  runs: number;
  failed: number;
}

export function webhookColumns(showScheme: boolean): string[] {
  return [
    "Route",
    ...(showScheme ? ["Verification"] : []),
    "Workflow",
    "Webhook runs",
    "Last run",
    "Runs",
    "Failed",
  ];
}

export function WebhookTable(
  { rows, runsLoading, now, onOpen }: {
    rows: WebhookRow[];
    runsLoading: boolean;
    now?: number;
    onOpen: (route: string) => void;
  },
) {
  const showScheme = rows.some((r) => r.scheme);
  return (
    <div className="table-wrap">
      <table className="data-table trig-table">
        <thead>
          <tr>
            {webhookColumns(showScheme).map((c) => (
              <th
                key={c}
                scope="col"
                className={c === "Runs" || c === "Failed" ? "num" : undefined}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.route}
              className="trig-row"
              onClick={rowClick(() => onOpen(row.route))}
            >
              <td className="trig-name">
                <RouteLink to={webhookRoute(row.route)} className="mono">
                  {row.route}
                </RouteLink>
              </td>
              {showScheme && (
                <td>
                  {row.scheme
                    ? <span className="trig-pill">{row.scheme}</span>
                    : <span className="trig-muted">—</span>}
                </td>
              )}
              <td>
                <RouteLink to={workflowRoute(row.workflowName)}>
                  {row.workflowName}
                </RouteLink>
              </td>
              <td className="trig-pips">
                {runsLoading
                  ? <SkeletonRunHistory slots={20} height={14} />
                  : (
                    <>
                      <RunHistoryBar
                        runs={row.recent}
                        workflowName={row.workflowName}
                        slots={20}
                        noun="webhook runs"
                      />
                      {row.sharedWith.length > 0 && (
                        <span
                          className="trig-shared"
                          title={`Runs don't record which route started them, so these are every webhook run of ${row.workflowName}, also started by ${
                            row.sharedWith.join(", ")
                          }`}
                        >
                          Shared by {row.sharedWith.length + 1} routes
                        </span>
                      )}
                    </>
                  )}
              </td>
              <td>
                {runsLoading
                  ? <span className="trig-muted">…</span>
                  : <LastRun run={row.recent[0]} now={now} />}
              </td>
              <td className="num">
                {runsLoading ? "…" : formatCount(row.runs)}
              </td>
              <td className="num">
                {runsLoading ? "…" : (
                  <span
                    className={row.failed > 0 ? "trig-failed" : undefined}
                  >
                    {formatCount(row.failed)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Run list on a detail page ───────────────────────────────────────────

export const RUN_COLUMNS = ["Status", "Run", "Started", "Duration", "Outcome"];

export function TriggerRunsTable(
  { runs, now, selected, onToggleSelect }: {
    runs: TriggerRun[];
    now?: number;
    /** Run ids picked for comparison; a Compare column shows when set. */
    selected?: readonly string[];
    onToggleSelect?: (runId: string) => void;
  },
) {
  const comparing = selected !== undefined && onToggleSelect !== undefined;
  return (
    <div className="table-wrap">
      <table className="data-table trig-table">
        <thead>
          <tr>
            {comparing && (
              <th scope="col" className="trig-check-col">
                <span className="visually-hidden">Compare</span>
              </th>
            )}
            {RUN_COLUMNS.map((c) => <th key={c} scope="col">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const picked = selected?.includes(run.runId) ?? false;
            return (
              <tr
                key={run.runId}
                className={picked ? "is-selected" : undefined}
              >
                {comparing && (
                  <td className="trig-check-col">
                    <input
                      type="checkbox"
                      checked={picked}
                      aria-label={`Compare run ${run.runId.slice(0, 8)}`}
                      onChange={() => onToggleSelect(run.runId)}
                    />
                  </td>
                )}
                <td>
                  <StatusPill status={run.status} />
                </td>
                <td>
                  <RouteLink
                    to={runRoute(run.workflowName, run.runId)}
                    className="mono"
                    title={run.runId}
                  >
                    {run.runId.slice(0, 8)}
                  </RouteLink>
                </td>
                <td>
                  {run.startedAt
                    ? <RelativeTime iso={run.startedAt} now={now} />
                    : "—"}
                </td>
                <td className="mono">{formatDuration(run.duration)}</td>
                <td className="trig-outcome">
                  {run.failedStep
                    ? (
                      <span title={run.failureReason}>
                        Failed at <span className="mono">{run.failedStep}</span>
                        {run.failureReason && (
                          <span className="trig-muted">
                            {` · ${run.failureReason}`}
                          </span>
                        )}
                      </span>
                    )
                    : run.stepProgress
                    ? (
                      <span className="trig-muted">
                        {run.stepProgress.completed}/{run.stepProgress.total}
                        {" "}
                        steps
                      </span>
                    )
                    : <span className="trig-muted">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
