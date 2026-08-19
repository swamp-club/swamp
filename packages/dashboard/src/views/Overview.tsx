import { useCallback, useEffect, useRef, useState } from "react";
import { useSwamp } from "../client/SwampProvider";
import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
import type { HealthSnapshot } from "../client/useHealthStream";
import { StatusDot } from "../components/StatusDot";
import { StatusPill } from "../components/StatusPill";
import { TriggerBadge } from "../components/TriggerBadge";

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
}

interface ApprovalInfo {
  workflowName: string;
  runId: string;
  steps: Array<{
    name: string;
    prompt?: string;
    timeout?: number;
    suspendedAt?: string;
  }>;
}

interface OverviewProps {
  health: HealthSnapshot | null;
  onOpenRun?: (workflowName: string, runId?: string) => void;
}

export function Overview({ health, onOpenRun }: OverviewProps) {
  const { request } = useSwamp();

  const { data: runsData } = useRequest("workflow.run.search", { limit: 500 });
  const { data: approvalsData } = useRequest("workflow.approvals");

  const runs = extractArray<WorkflowRunSearchItem>(runsData);
  const approvals = extractArray<ApprovalInfo>(approvalsData);

  const totalRuns = runs.length;
  const succeededRuns = runs.filter((r) => r.status === "succeeded").length;
  const successRate = totalRuns > 0
    ? ((succeededRuns / totalRuns) * 100).toFixed(1)
    : "0";
  const failedRuns = runs.filter((r) => r.status === "failed").slice(0, 4);
  const liveRuns = runs.filter(
    (r) => r.status === "running" || r.status === "suspended",
  );

  const handleApprove = useCallback(
    async (workflowName: string, stepName: string) => {
      await request("workflow.approve", {
        workflowIdOrName: workflowName,
        stepName,
      });
    },
    [request],
  );

  const handleReject = useCallback(
    async (workflowName: string, stepName: string) => {
      await request("workflow.reject", {
        workflowIdOrName: workflowName,
        stepName,
      });
    },
    [request],
  );

  return (
    <>
      <div className="page-header">
        <h1>Dashboard</h1>
        <div className="header-right">
          {health && (
            <div className="health-pill">
              <span className="health-dot" />
              {health.ready ? "Healthy" : "Degraded"}
            </div>
          )}
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Runs</div>
          <div className="stat-value">{totalRuns.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Success Rate</div>
          <div className="stat-value" style={{ color: "var(--success)" }}>
            {successRate}%
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Throughput</div>
          <div className="stat-value">
            {health?.metrics?.throughputPerMinute?.toFixed(1) ?? "—"}
            <span style={{ fontSize: "0.9rem", color: "var(--text-3)" }}>
              /min
            </span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">P95 Latency</div>
          <div className="stat-value">
            {health?.metrics?.latency?.p95
              ? `${(health.metrics.latency.p95 / 1000).toFixed(1)}s`
              : "—"}
          </div>
        </div>
      </div>

      <ExecutionChart runs={runs} />

      <div className="panels-grid">
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              Live Runs <span className="panel-count">{liveRuns.length}</span>
            </div>
          </div>
          <div>
            {liveRuns.length === 0 && (
              <div className="loading">No active runs</div>
            )}
            {liveRuns.map((run) => (
              <div className="run-row" key={run.runId} onClick={() => onOpenRun?.(run.workflowName, run.runId)}>
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
                  {approvals.reduce((n, a) => n + a.steps.length, 0)}
                </span>
              )}
            </div>
          </div>
          <div>
            {approvals.length === 0 && (
              <div className="loading">No pending approvals</div>
            )}
            {approvals.flatMap((a) =>
              a.steps.map((step) => (
                <div className="approval-row" key={`${a.runId}-${step.name}`}>
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
                    {step.prompt && (
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--text-3)",
                          marginTop: 2,
                        }}
                      >
                        {step.prompt}
                      </div>
                    )}
                  </div>
                  <div className="approval-actions">
                    <button
                      type="button"
                      className="btn-sm btn-approve"
                      onClick={() =>
                        handleApprove(a.workflowName, step.name)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn-sm btn-reject"
                      onClick={() =>
                        handleReject(a.workflowName, step.name)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="panels-grid" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Upcoming Schedules</div>
          </div>
          <div>
            {(!health?.scheduling?.schedules?.length) && (
              <div className="loading">No schedules configured</div>
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
              Recent Failures{" "}
              <span className="panel-count">{failedRuns.length}</span>
            </div>
          </div>
          <div>
            {failedRuns.length === 0 && (
              <div className="loading">No recent failures</div>
            )}
            {failedRuns.map((run) => (
              <div className="run-row" key={run.runId} onClick={() => onOpenRun?.(run.workflowName, run.runId)}>
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

function ExecutionChart({ runs }: { runs: WorkflowRunSearchItem[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<BarHit[]>([]);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    day: string;
    data: Record<string, number>;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || runs.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = globalThis.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    const buckets = new Map<string, Record<string, number>>();
    for (const run of runs) {
      const day = run.startedAt.slice(0, 10);
      if (!buckets.has(day)) {
        buckets.set(day, {
          succeeded: 0,
          failed: 0,
          suspended: 0,
          running: 0,
          cancelled: 0,
        });
      }
      const b = buckets.get(day)!;
      b[run.status] = (b[run.status] ?? 0) + 1;
    }

    const days = [...buckets.keys()].sort().slice(-7);
    const data = days.map((d) => buckets.get(d)!);

    const style = getComputedStyle(document.documentElement);
    const colors: Record<string, string> = {
      succeeded: style.getPropertyValue("--chart-bar-1").trim(),
      failed: style.getPropertyValue("--chart-bar-2").trim(),
      suspended: style.getPropertyValue("--chart-bar-3").trim(),
      running: style.getPropertyValue("--chart-bar-4").trim(),
      cancelled: style.getPropertyValue("--chart-bar-5").trim(),
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
    const niceMax = Math.ceil(maxVal / 50) * 50 || 50;
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
        String(Math.round((niceMax * i) / 4)),
        pad.left - 6,
        y + 3.5,
      );
    }

    const keys = ["succeeded", "failed", "suspended", "running", "cancelled"];
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
      const label = days[i].slice(5);
      ctx.fillText(label, x + barW / 2, H - 6);
    });

    barsRef.current = hits;
  }, [runs]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      for (const bar of barsRef.current) {
        if (mx >= bar.x && mx <= bar.x + bar.w && my < rect.height - 20) {
          setTooltip({ x: bar.x + bar.w / 2, y: 0, day: bar.day, data: bar.data });
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
    <div className="chart-section">
      <div className="chart-header">
        <span className="chart-title">Executions</span>
        <div className="chart-legend">
          <span>
            <span
              className="legend-dot"
              style={{ background: "var(--chart-bar-1)" }}
            />
            Succeeded
          </span>
          <span>
            <span
              className="legend-dot"
              style={{ background: "var(--chart-bar-2)" }}
            />
            Failed
          </span>
          <span>
            <span
              className="legend-dot"
              style={{ background: "var(--chart-bar-3)" }}
            />
            Suspended
          </span>
        </div>
      </div>
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
              {tooltip.day} &middot; {total} runs
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
            {tooltip.data.suspended > 0 && (
              <div style={{ color: "var(--warning)" }}>
                {tooltip.data.suspended} suspended
              </div>
            )}
            {tooltip.data.running > 0 && (
              <div style={{ color: "var(--running)" }}>
                {tooltip.data.running} running
              </div>
            )}
            {tooltip.data.cancelled > 0 && (
              <div style={{ color: "var(--cancelled)" }}>
                {tooltip.data.cancelled} cancelled
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem.toString().padStart(2, "0")}s`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) {
    const absDiff = Math.abs(diff);
    if (absDiff < 3600000) return `in ${Math.floor(absDiff / 60000)}m`;
    if (absDiff < 86400000) return `in ${Math.floor(absDiff / 3600000)}h`;
    return `in ${Math.floor(absDiff / 86400000)}d`;
  }
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
