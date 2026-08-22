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

import { useRequest } from "../client/useRequest";
import { extractObject } from "../client/extract";
import { StatusPill } from "../components/StatusPill";
import { StatusDot } from "../components/StatusDot";

interface LogsData {
  path?: string;
  lines?: string[];
  lineCount?: number;
}

interface StepRun {
  name: string;
  status: string;
  error?: string;
  duration?: number;
  modelName?: string;
  methodName?: string;
  allowedFailure?: boolean;
  dataArtifacts?: Array<{
    dataId: string;
    name: string;
    version: number;
  }>;
}

interface JobRun {
  name: string;
  status: string;
  steps: StepRun[];
  duration?: number;
}

interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  jobs: JobRun[];
}

interface RunDetailProps {
  workflowName: string;
  runId?: string;
  onBack: () => void;
}

export function RunDetail({ workflowName, runId, onBack }: RunDetailProps) {
  const { data, loading, error } = useRequest(
    "workflow.history.get",
    { workflowIdOrName: runId ?? workflowName },
  );
  const { data: logsData } = useRequest(
    "workflow.history.logs",
    { runIdOrWorkflow: runId ?? workflowName, tail: 200 },
  );

  const run = error ? null : extractObject<WorkflowRun>(data);
  const logs = extractLogs(logsData);

  return (
    <>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              border: "1px solid var(--border)",
              background: "var(--surface)",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              color: "var(--text-2)",
              fontFamily: "inherit",
              fontSize: "0.82rem",
            }}
          >
            &larr; Back
          </button>
          <h1>{workflowName}</h1>
          {run && <StatusPill status={run.status} />}
        </div>
        <div className="header-right">
          {runId && (
            <span
              className="mono"
              style={{ fontSize: "0.75rem", color: "var(--text-3)" }}
            >
              {runId.slice(0, 8)}
            </span>
          )}
          {run?.duration !== undefined && (
            <span
              className="mono"
              style={{ fontSize: "0.78rem", color: "var(--text-2)" }}
            >
              {formatDuration(run.duration)}
            </span>
          )}
        </div>
      </div>

      {loading && <div className="loading">Loading run details...</div>}

      {error && !run && (
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Run Details Unavailable</div>
          </div>
          <div
            style={{
              padding: 18,
              color: "var(--text-2)",
              fontSize: "0.85rem",
            }}
          >
            <p style={{ marginBottom: 8 }}>
              Step-level detail for this run could not be loaded.
            </p>
            <p style={{ color: "var(--text-3)", fontSize: "0.82rem" }}>
              This can happen when the run was executed via the CLI rather than
              through swamp serve. Run summary data is available in the
              Executions view.
            </p>
            <div
              style={{
                marginTop: 12,
                padding: "8px 12px",
                background: "var(--danger-bg)",
                borderRadius: 4,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.75rem",
                color: "var(--danger)",
              }}
            >
              {error}
            </div>
          </div>
        </div>
      )}

      {run && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {run.jobs.map((job) => (
            <div className="panel" key={job.name}>
              <div className="panel-header">
                <div className="panel-title">
                  <StatusDot status={job.status} />
                  {job.name}
                  <StatusPill status={job.status} />
                </div>
                {job.duration !== undefined && (
                  <span
                    className="mono"
                    style={{ fontSize: "0.75rem", color: "var(--text-3)" }}
                  >
                    {formatDuration(job.duration)}
                  </span>
                )}
              </div>
              <div>
                {(job.steps ?? []).map((step) => (
                  <div
                    key={step.name}
                    style={{
                      padding: "10px 18px",
                      borderBottom: "1px solid var(--border-subtle)",
                      display: "grid",
                      gridTemplateColumns: "auto 1fr auto auto",
                      alignItems: "start",
                      gap: 12,
                    }}
                  >
                    <StatusDot status={step.status} />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 500,
                          fontSize: "0.85rem",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {step.name}
                        {step.allowedFailure && (
                          <span
                            className="mono"
                            style={{
                              fontSize: "0.6rem",
                              color: "var(--text-3)",
                              background: "var(--surface-inset)",
                              padding: "1px 5px",
                              borderRadius: 3,
                            }}
                          >
                            allow-failure
                          </span>
                        )}
                      </div>
                      {step.modelName && (
                        <div
                          className="mono"
                          style={{
                            fontSize: "0.72rem",
                            color: "var(--text-3)",
                            marginTop: 2,
                          }}
                        >
                          {step.modelName}
                          {step.methodName ? `.${step.methodName}` : ""}
                        </div>
                      )}
                      {step.error && (
                        <div
                          style={{
                            marginTop: 6,
                            padding: "6px 10px",
                            borderRadius: 4,
                            background: "var(--danger-bg)",
                            color: "var(--danger)",
                            fontSize: "0.78rem",
                            fontFamily: "'JetBrains Mono', monospace",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {step.error}
                        </div>
                      )}
                      {step.dataArtifacts && step.dataArtifacts.length > 0 && (
                        <div
                          style={{
                            marginTop: 6,
                            display: "flex",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          {step.dataArtifacts.map((da) => (
                            <span className="cron-badge" key={da.dataId}>
                              {da.name} v{da.version}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span
                      className="mono"
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--text-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatDuration(step.duration)}
                    </span>
                    <StatusPill status={step.status} />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {logs?.lines && logs.lines.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">
                  Execution Logs{" "}
                  <span className="panel-count">
                    {logs.lineCount ?? logs.lines.length} lines
                  </span>
                </div>
              </div>
              <pre
                className="code-block"
                style={{
                  maxHeight: 400,
                  overflowY: "auto",
                  fontSize: "0.72rem",
                  lineHeight: 1.5,
                }}
              >
                {logs.lines.map((line, i) => {
                  const isError = /\[ERR\]|\[error\]|failed|Error/i.test(line);
                  const isWarn = /\[WRN\]|\[warning\]|warn/i.test(line);
                  return (
                    <span
                      key={i}
                      style={{
                        display: "block",
                        color: isError
                          ? "var(--danger)"
                          : isWarn
                          ? "var(--warning)"
                          : undefined,
                      }}
                    >
                      {line}
                    </span>
                  );
                })}
              </pre>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function extractLogs(payload: unknown): LogsData | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  // payload.data.log.lines
  if (obj.data && typeof obj.data === "object") {
    const d = obj.data as Record<string, unknown>;
    if (d.log && typeof d.log === "object") {
      const log = d.log as Record<string, unknown>;
      if (Array.isArray(log.lines)) {
        return log as unknown as LogsData;
      }
    }
    // payload.data.lines
    if (Array.isArray(d.lines)) {
      return d as unknown as LogsData;
    }
  }

  // payload.log.lines
  if (obj.log && typeof obj.log === "object") {
    const log = obj.log as Record<string, unknown>;
    if (Array.isArray(log.lines)) {
      return log as unknown as LogsData;
    }
  }

  // payload.lines
  if (Array.isArray(obj.lines)) {
    return obj as unknown as LogsData;
  }

  return null;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem.toString().padStart(2, "0")}s`;
}
