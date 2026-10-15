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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSwamp } from "../client/SwampProvider.tsx";
import { useRequest } from "../client/useRequest.ts";
import { extractArray } from "../client/extract.ts";
import { type ApprovalInfo, pendingApprovals } from "../client/approvals.ts";
import type { HealthSnapshot } from "../client/useHealthStream.ts";
import { healthViewState } from "../client/health_state.ts";
import { StatusDot } from "../components/StatusDot.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { TriggerBadge } from "../components/TriggerBadge.tsx";
import { ResumeAction } from "../components/ResumeAction.tsx";
import { totalQueued } from "./schedule_queue.ts";
import { activeRunIds } from "../client/resume_state.ts";
import { useActiveRunsRefetch } from "../client/useActiveRunsRefetch.ts";
import { HealthUnavailable } from "../components/HealthUnavailable.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { LoadError } from "../components/LoadError.tsx";
import { Skeleton, SkeletonList } from "../components/Skeleton.tsx";
import { loadState } from "../client/load_state.ts";
import { WorkersPill } from "../components/WorkersPill.tsx";
import { type FleetWorker, workerSummary } from "../lib/host_map_model.ts";
import { useCoalescedRefetch } from "../client/useFleetData.ts";
import { useRunSummary } from "../client/run_summary.ts";
import { useTimeBounds } from "../client/time_range.ts";
import { chartAxis, type ChartBar, chartBars } from "./overview_chart.ts";
import {
  formatCount,
  formatDuration,
  formatRelativeTime,
  pluralize,
} from "../lib/format.ts";
import {
  CountSkeleton,
  ExecutionChartFrame,
  ExecutionChartSkeleton,
  ScheduleRowsSkeleton,
  StatValueSkeleton,
} from "./PageSkeletons.tsx";

interface WorkflowRunSearchItem {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  duration?: number;
  triggerSource?: string;
  stepProgress?: { completed: number; total: number };
  failedStep?: string;
  failureReason?: string;
  awaitingResume?: boolean;
  workflowHasInputs?: boolean;
}

interface OverviewProps {
  health: HealthSnapshot | null;
  /** Serve refused the health stream for this token. */
  healthDenied: boolean;
  onOpenRun?: (workflowName: string, runId?: string) => void;
  /** Called after a gate decision or resume, so the sidebar count refreshes. */
  onApprovalsChanged?: () => void;
}

export function Overview(
  { health, healthDenied, onOpenRun, onApprovalsChanged }: OverviewProps,
) {
  const healthState = healthViewState(health, healthDenied);
  const queuedFires = totalQueued(health?.scheduling?.schedules ?? []);
  const { request } = useSwamp();

  const runsReq = useRequest("workflow.run.search", { limit: 500 });
  const approvalsReq = useRequest("workflow.approvals");
  const { data: runsData, refetch: refetchRuns } = runsReq;
  const { data: approvalsData, refetch: refetchApprovals } = approvalsReq;

  const runs = extractArray<WorkflowRunSearchItem>(runsData);
  const approvals = pendingApprovals(approvalsData);
  const runsState = loadState(runsReq, () => runs.length === 0);
  const approvalsState = loadState(approvalsReq, () => approvals.length === 0);
  const runsLoading = runsState === "loading";
  const healthLoading = healthState === "loading";

  // Totals and the chart come from serve's run summary for the selected
  // time range, so they are exact rather than "the newest 500 runs".
  const bounds = useTimeBounds();
  const summaryReq = useRunSummary({ timeline: true, recentLimit: 0 });
  const summary = summaryReq.summary;
  const totals = summary?.totals;
  const summaryState = loadState(
    { data: summary, loading: summaryReq.loading, error: summaryReq.error },
    (s) => s.totals.runs === 0,
  );
  const totalRuns = totals?.runs ?? 0;
  const finishedRuns = totals
    ? totals.succeeded + totals.failed + totals.cancelled
    : 0;
  const successRate = totals && finishedRuns > 0
    ? `${((totals.succeeded / finishedRuns) * 100).toFixed(1)}%`
    : "—";
  const bars = useMemo(
    () => summary ? chartBars(summary.timeline ?? [], bounds) : [],
    [summary, bounds],
  );
  const failedRuns = runs.filter((r) => r.status === "failed").slice(0, 4);
  const liveRuns = runs.filter(
    (r) => r.status === "running" || r.status === "suspended",
  );

  const refresh = useCallback(() => {
    refetchRuns();
    refetchApprovals();
    onApprovalsChanged?.();
  }, [refetchRuns, refetchApprovals, onApprovalsChanged]);

  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [resumingRuns, setResumingRuns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Runs serve drives now, whoever approved them (swamp-club#3005).
  const servedRuns = activeRunIds(health?.activeRuns);
  const refetchRunsAndApprovals = useCallback(() => {
    refetchRuns();
    refetchApprovals();
  }, [refetchRuns, refetchApprovals]);
  useActiveRunsRefetch(health?.activeRuns, runs, refetchRunsAndApprovals);

  const decide = useCallback(
    async (type: "workflow.approve" | "workflow.reject", a: ApprovalInfo) => {
      setDecisionError(null);
      try {
        const result = await request<{ data?: { autoResumed?: boolean } }>(
          type,
          {
            workflowIdOrName: a.workflowName,
            stepName: a.stepName,
            runId: a.runId,
          },
        );
        if (result.data?.autoResumed) {
          setResumingRuns((prev) => new Set(prev).add(a.runId));
        }
      } catch (err) {
        setDecisionError(err instanceof Error ? err.message : String(err));
      }
      refresh();
    },
    [request, refresh],
  );

  const handleApprove = useCallback(
    (a: ApprovalInfo) => decide("workflow.approve", a),
    [decide],
  );

  const handleReject = useCallback(
    (a: ApprovalInfo) => decide("workflow.reject", a),
    [decide],
  );

  // Admin-only: a token that cannot list workers just gets no pill.
  const workersReq = useRequest<{ data?: { workers?: FleetWorker[] } }>(
    "worker.list",
  );
  useCoalescedRefetch(health?.workers, workersReq.refetch);
  const listedWorkers = workersReq.data?.data?.workers ?? [];
  const workersSummary = listedWorkers.length > 0
    ? workerSummary(listedWorkers)
    : null;

  return (
    <>
      <div className="page-header">
        <h1>Dashboard</h1>
        <div className="header-right">
          {workersSummary && <WorkersPill summary={workersSummary} />}
          {health && (
            <div className="health-pill">
              <span className="health-dot" />
              {health.ready ? "Healthy" : "Degraded"}
            </div>
          )}
          {healthLoading && <Skeleton width={84} height={26} radius={20} />}
        </div>
      </div>

      <div
        className="stats-grid"
        aria-busy={runsLoading || healthLoading || undefined}
      >
        <div className="stat-card">
          <div className="stat-label">Total Runs</div>
          <div className="stat-value">
            {summaryState === "loading"
              ? <StatValueSkeleton />
              : formatCount(totalRuns)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Success Rate</div>
          <div
            className="stat-value"
            style={finishedRuns > 0 ? { color: "var(--success)" } : undefined}
            title="Succeeded out of finished runs in the selected time range"
          >
            {summaryState === "loading"
              ? <StatValueSkeleton width={96} />
              : successRate}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Throughput</div>
          <div className="stat-value">
            {healthLoading ? <StatValueSkeleton width={72} /> : (
              <>
                {health?.metrics?.throughputPerMinute?.toFixed(1) ?? "—"}
                <span style={{ fontSize: "0.9rem", color: "var(--text-3)" }}>
                  /min
                </span>
              </>
            )}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">P95 Latency</div>
          <div className="stat-value">
            {healthLoading
              ? <StatValueSkeleton width={64} />
              : health?.metrics?.latency?.p95
              ? `${(health.metrics.latency.p95 / 1000).toFixed(1)}s`
              : "—"}
          </div>
        </div>
      </div>

      {summaryState === "loading" && <ExecutionChartSkeleton />}
      {summaryState === "error" && (
        <ExecutionChartFrame>
          <LoadError
            subject="runs"
            message={summaryReq.error}
            onRetry={summaryReq.refetch}
            style={{ marginBottom: 0 }}
          />
        </ExecutionChartFrame>
      )}
      {summaryState === "empty" && (
        <ExecutionChartFrame>
          <EmptyState title="No runs in this time range">
            Runs started by a schedule, a webhook or{" "}
            <code>swamp workflow run</code> are charted here by day.
          </EmptyState>
        </ExecutionChartFrame>
      )}
      {summaryState === "ready" && <ExecutionChart bars={bars} />}

      <div className="panels-grid">
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              Live Runs {runsLoading
                ? <CountSkeleton />
                : <span className="panel-count">{liveRuns.length}</span>}
            </div>
          </div>
          <div>
            {runsState === "loading" && (
              <SkeletonList rows={3} label="Loading live runs" />
            )}
            {runsState === "error" && (
              <LoadError
                subject="runs"
                message={runsReq.error}
                onRetry={refetchRuns}
                inset
              />
            )}
            {(runsState === "empty" || runsState === "ready") &&
              liveRuns.length === 0 && (
              <EmptyState title="No active runs">
                Running and suspended runs show here with their step progress.
              </EmptyState>
            )}
            {liveRuns.map((run) => (
              <div
                className="run-row"
                key={run.runId}
                onClick={() => onOpenRun?.(run.workflowName, run.runId)}
              >
                <StatusDot status={run.status} />
                <div className="run-info">
                  <div className="run-name">{run.workflowName}</div>
                  <div className="run-detail">
                    {run.stepProgress
                      ? `step ${run.stepProgress.completed}/${run.stepProgress.total}`
                      : run.status}
                    {run.status === "running" && run.stepProgress && (
                      <div className="progress-bar">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${
                              (run.stepProgress.completed /
                                run.stepProgress.total) * 100
                            }%`,
                          }}
                        />
                      </div>
                    )}
                  </div>
                  <ResumeAction
                    run={run}
                    onResumed={refresh}
                    resuming={resumingRuns.has(run.runId) ||
                      servedRuns.has(run.runId)}
                  />
                </div>
                <span className="run-duration">
                  {formatDuration(run.duration)}
                </span>
                <TriggerBadge trigger={run.triggerSource} />
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              Pending Approvals {approvals.length > 0 && (
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "0.65rem",
                    fontWeight: 500,
                    padding: "1px 7px",
                    borderRadius: 10,
                    background: "var(--warning)",
                    color: "#000",
                  }}
                >
                  {approvals.length}
                </span>
              )}
            </div>
          </div>
          <div>
            {decisionError && (
              <div className="resume-error" style={{ padding: "8px 18px" }}>
                {decisionError}
              </div>
            )}
            {approvalsState === "loading" && (
              <SkeletonList rows={2} label="Loading pending approvals" />
            )}
            {approvalsState === "error" && (
              <LoadError
                subject="approvals"
                message={approvalsReq.error}
                onRetry={refetchApprovals}
                inset
              />
            )}
            {approvalsState === "empty" && (
              <EmptyState title="No pending approvals">
                Workflow steps waiting for a manual approval show here, ready to
                approve or reject.
              </EmptyState>
            )}
            {approvals.map((a) => (
              <div className="approval-row" key={`${a.runId}-${a.stepName}`}>
                <div>
                  <div
                    style={{
                      fontWeight: 500,
                      fontSize: "0.85rem",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {a.workflowName}
                    <StatusPill status="suspended" />
                  </div>
                  {a.prompt && (
                    <div
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--text-3)",
                        marginTop: 2,
                      }}
                    >
                      {a.prompt}
                    </div>
                  )}
                </div>
                <div className="approval-actions">
                  <button
                    type="button"
                    className="btn-sm btn-approve"
                    onClick={() =>
                      handleApprove(a)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-reject"
                    onClick={() =>
                      handleReject(a)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panels-grid" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              Upcoming Schedules
              {queuedFires > 0 && (
                <>
                  {" "}
                  <span className="panel-count">{queuedFires} queued</span>
                </>
              )}
            </div>
          </div>
          <div>
            {healthState !== "ready" && (
              <HealthUnavailable
                state={healthState}
                subject="schedules"
                skeleton={<ScheduleRowsSkeleton />}
              />
            )}
            {healthState === "ready" &&
              !health?.scheduling?.schedules?.length && (
              <EmptyState title="No upcoming schedules">
                Workflows with a cron trigger show here with their next run.
                None are visible to this token.
              </EmptyState>
            )}
            {(health?.scheduling?.schedules ?? []).map((s) => (
              <div className="schedule-row" key={s.workflowId}>
                <span className="schedule-name">
                  {s.workflowName ?? s.workflowId}
                </span>
                <span className="cron-badge">{s.cronExpression}</span>
                <span className="run-time">
                  {s.nextRun ? formatRelativeTime(s.nextRun) : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              Recent Failures {runsLoading
                ? <CountSkeleton />
                : <span className="panel-count">{failedRuns.length}</span>}
            </div>
          </div>
          <div>
            {runsState === "loading" && (
              <SkeletonList rows={4} label="Loading recent failures" />
            )}
            {runsState === "error" && (
              <LoadError
                subject="runs"
                message={runsReq.error}
                onRetry={refetchRuns}
                inset
              />
            )}
            {(runsState === "empty" || runsState === "ready") &&
              failedRuns.length === 0 && (
              <EmptyState title="No recent failures">
                None of the latest runs failed. Failed runs show here with the
                step that failed and why.
              </EmptyState>
            )}
            {failedRuns.map((run) => (
              <div
                className="run-row"
                key={run.runId}
                onClick={() => onOpenRun?.(run.workflowName, run.runId)}
              >
                <StatusDot status="failed" />
                <div className="run-info">
                  <div className="run-name">{run.workflowName}</div>
                  <div className="run-detail">
                    {run.failedStep
                      ? `step: ${run.failedStep}`
                      : "unknown step"}
                    {run.failureReason ? ` · ${run.failureReason}` : ""}
                  </div>
                </div>
                <span className="run-duration">
                  {formatDuration(run.duration)}
                </span>
                <span className="run-time">
                  {formatRelativeTime(run.startedAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

interface BarHit {
  x: number;
  w: number;
  day: string;
  data: Record<string, number>;
}

function ExecutionChart({ bars }: { bars: ChartBar[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<BarHit[]>([]);
  const [tooltip, setTooltip] = useState<
    {
      x: number;
      y: number;
      day: string;
      data: Record<string, number>;
    } | null
  >(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || bars.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = globalThis.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    const days = bars.map((bar) => bar.day);
    const data: Record<string, number>[] = bars.map((bar) => bar.data);

    const style = getComputedStyle(document.documentElement);
    const colors: Record<string, string> = {
      succeeded: style.getPropertyValue("--chart-bar-1").trim(),
      failed: style.getPropertyValue("--chart-bar-2").trim(),
      cancelled: style.getPropertyValue("--chart-bar-5").trim(),
      other: style.getPropertyValue("--chart-bar-4").trim(),
    };
    const gridColor = style.getPropertyValue("--chart-grid").trim();
    const labelColor = style.getPropertyValue("--chart-label").trim();
    const surfaceColor = style.getPropertyValue("--surface").trim();

    const pad = { top: 8, right: 12, bottom: 28, left: 36 };
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom;

    const maxVal = Math.max(
      ...data.map((d) => Object.values(d).reduce((a, b) => a + b, 0)),
      1,
    );
    const axis = chartAxis(maxVal);
    const niceMax = axis.max;
    const barW = Math.min((chartW / days.length) * 0.55, 40);
    const gap = chartW / days.length;

    const hits: BarHit[] = [];

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + chartH - (chartH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = labelColor;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = "right";
      ctx.fillText(
        String(axis.ticks[i]),
        pad.left - 6,
        y + 3.5,
      );
    }

    const keys = ["succeeded", "failed", "cancelled", "other"];
    data.forEach((d, i) => {
      const x = pad.left + gap * i + (gap - barW) / 2;
      let y = pad.top + chartH;

      hits.push({ x, w: barW, day: days[i], data: d });

      keys.forEach((k, ki) => {
        const h = ((d[k] ?? 0) / niceMax) * chartH;
        if (h > 0) {
          y -= h;
          ctx.fillStyle = colors[k];
          const isTop = keys.slice(ki + 1).every((kk) => (d[kk] ?? 0) === 0);
          const r = 2;
          ctx.beginPath();
          if (isTop) {
            ctx.moveTo(x, y + r);
            ctx.arcTo(x, y, x + r, y, r);
            ctx.arcTo(x + barW, y, x + barW, y + r, r);
            ctx.lineTo(x + barW, y + h);
            ctx.lineTo(x, y + h);
          } else {
            ctx.rect(x, y, barW, h);
          }
          ctx.fill();
          if (ki > 0) {
            ctx.fillStyle = surfaceColor;
            ctx.fillRect(x, y + h - 1, barW, 2);
          }
        }
      });

      ctx.fillStyle = labelColor;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = "center";
      // Thin the labels out so long ranges don't overprint.
      const every = Math.ceil(days.length / Math.max(1, chartW / 48));
      if (i % every === 0) {
        ctx.fillText(bars[i].label, x + barW / 2, H - 6);
      }
    });

    barsRef.current = hits;
  }, [bars]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      for (const bar of barsRef.current) {
        if (mx >= bar.x && mx <= bar.x + bar.w && my < rect.height - 20) {
          setTooltip({
            x: bar.x + bar.w / 2,
            y: 0,
            day: bar.day,
            data: bar.data,
          });
          return;
        }
      }
      setTooltip(null);
    },
    [],
  );

  const total = tooltip
    ? Object.values(tooltip.data).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <ExecutionChartFrame>
      <div className="chart-area" style={{ position: "relative" }}>
        <canvas
          ref={canvasRef}
          className="chart-canvas"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setTooltip(null)}
        />
        {tooltip && (
          <div
            ref={tooltipRef}
            style={{
              position: "absolute",
              left: tooltip.x,
              top: 4,
              transform: "translateX(-50%)",
              background: "var(--sidebar-bg)",
              color: "var(--sidebar-text-active)",
              borderRadius: 6,
              padding: "8px 12px",
              fontSize: "0.75rem",
              fontFamily: "'JetBrains Mono', monospace",
              pointerEvents: "none",
              zIndex: 10,
              whiteSpace: "nowrap",
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {tooltip.day} &middot; {pluralize(total, "run")}
            </div>
            {tooltip.data.succeeded > 0 && (
              <div style={{ color: "var(--success)" }}>
                {tooltip.data.succeeded} succeeded
              </div>
            )}
            {tooltip.data.failed > 0 && (
              <div style={{ color: "var(--danger)" }}>
                {tooltip.data.failed} failed
              </div>
            )}
            {tooltip.data.cancelled > 0 && (
              <div style={{ color: "var(--cancelled)" }}>
                {tooltip.data.cancelled} cancelled
              </div>
            )}
            {tooltip.data.other > 0 && (
              <div style={{ color: "var(--running)" }}>
                {tooltip.data.other} running or waiting
              </div>
            )}
          </div>
        )}
      </div>
    </ExecutionChartFrame>
  );
}
