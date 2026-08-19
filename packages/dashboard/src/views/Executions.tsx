import { useState } from "react";
import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
import { StatusPill } from "../components/StatusPill";
import { TriggerBadge } from "../components/TriggerBadge";

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
  onOpenRun?: (workflowName: string, runId?: string) => void;
}

const PAGE_SIZE = 25;

export function Executions({ onOpenRun }: ExecutionsProps) {
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [page, setPage] = useState(0);

  const payload: Record<string, unknown> = { limit: 500 };
  if (statusFilter) payload.status = statusFilter;

  const { data } = useRequest("workflow.run.search", payload);
  const allRuns = extractArray<RunItem>(data);

  const totalPages = Math.ceil(allRuns.length / PAGE_SIZE);
  const runs = allRuns.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const statuses = [
    "",
    "succeeded",
    "failed",
    "running",
    "suspended",
    "cancelled",
  ];

  const handleStatusChange = (s: string | undefined) => {
    setStatusFilter(s);
    setPage(0);
  };

  return (
    <>
      <div className="page-header">
        <h1>Executions</h1>
        <div className="header-right">
          <span
            className="mono"
            style={{ fontSize: "0.75rem", color: "var(--text-3)" }}
          >
            {allRuns.length} total
          </span>
          <div className="time-range">
            {statuses.map((s) => (
              <button
                type="button"
                key={s}
                className={(statusFilter ?? "") === s ? "active" : ""}
                onClick={() => handleStatusChange(s || undefined)}
              >
                {s || "All"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Workflow</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Duration</th>
                <th>Steps</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.runId}
                  onClick={() => onOpenRun?.(run.workflowName, run.runId)}
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    <span
                      className="mono"
                      style={{ fontSize: "0.75rem", color: "var(--accent)" }}
                    >
                      {run.runId.slice(0, 8)}
                    </span>
                  </td>
                  <td style={{ fontWeight: 500 }}>{run.workflowName}</td>
                  <td>
                    <StatusPill status={run.status} />
                  </td>
                  <td>
                    <TriggerBadge trigger={run.triggerSource} />
                  </td>
                  <td
                    className="mono"
                    style={{ fontSize: "0.78rem", color: "var(--text-2)" }}
                  >
                    {formatDuration(run.duration)}
                  </td>
                  <td
                    className="mono"
                    style={{ fontSize: "0.75rem", color: "var(--text-3)" }}
                  >
                    {run.stepProgress
                      ? `${run.stepProgress.completed}/${run.stepProgress.total}`
                      : "—"}
                  </td>
                  <td style={{ fontSize: "0.78rem", color: "var(--text-3)" }}>
                    {formatRelativeTime(run.startedAt)}
                  </td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      textAlign: "center",
                      color: "var(--text-3)",
                      padding: 32,
                    }}
                  >
                    No executions found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 18px",
              borderTop: "1px solid var(--border)",
              fontSize: "0.78rem",
              color: "var(--text-3)",
            }}
          >
            <span>
              Showing {page * PAGE_SIZE + 1}–
              {Math.min((page + 1) * PAGE_SIZE, allRuns.length)} of{" "}
              {allRuns.length}
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                type="button"
                className="btn-sm"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                style={{ opacity: page === 0 ? 0.4 : 1 }}
              >
                Previous
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let p = i;
                if (totalPages > 7) {
                  if (page < 4) p = i;
                  else if (page > totalPages - 4) p = totalPages - 7 + i;
                  else p = page - 3 + i;
                }
                return (
                  <button
                    type="button"
                    key={p}
                    onClick={() => setPage(p)}
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: "0.72rem",
                      padding: "4px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      background: p === page
                        ? "var(--accent-subtle)"
                        : "transparent",
                      color: p === page ? "var(--accent)" : "var(--text-3)",
                      cursor: "pointer",
                    }}
                  >
                    {p + 1}
                  </button>
                );
              })}
              <button
                type="button"
                className="btn-sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(page + 1)}
                style={{ opacity: page >= totalPages - 1 ? 0.4 : 1 }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </>
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
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
