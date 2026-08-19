import { extractArray, extractObject } from "../client/extract";
import { CodeBlock } from "../components/CodeBlock";
import * as yaml from "js-yaml";
import { useRequest } from "../client/useRequest";
import { StatusDot } from "../components/StatusDot";
import { StatusPill } from "../components/StatusPill";
import { TriggerBadge } from "../components/TriggerBadge";

interface WorkflowDetailProps {
  workflowName: string;
  onBack: () => void;
  onOpenRun?: (workflowName: string, runId?: string) => void;
}

interface RunSummary {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  duration?: number;
  triggerSource?: string;
}

interface StepDef {
  name: string;
  task: {
    type: string;
    modelIdOrName?: string;
    methodName?: string;
  };
  dependsOn?: Array<unknown>;
}

interface JobDef {
  name: string;
  steps: StepDef[];
  dependsOn?: Array<unknown>;
}

interface WorkflowData {
  id: string;
  name: string;
  version?: number;
  tags?: Record<string, string>;
  trigger?: { schedule?: string };
  jobs: JobDef[];
  path?: string;
}

export function WorkflowDetail(
  { workflowName, onBack, onOpenRun }: WorkflowDetailProps,
) {
  const { data: wfData } = useRequest("workflow.get", {
    workflowIdOrName: workflowName,
  });
  const { data: runsData } = useRequest("workflow.run.search", {
    workflow: workflowName,
    limit: 20,
  });

  const workflow = extractObject<WorkflowData>(wfData);
  const recentRuns = extractArray<RunSummary>(runsData);

  const succeeded = recentRuns.filter((r) => r.status === "succeeded").length;
  const failed = recentRuns.filter((r) => r.status === "failed").length;
  const total = recentRuns.length;

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
          {workflow?.trigger?.schedule && (
            <TriggerBadge trigger="schedule" />
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Stats row */}
        {total > 0 && (
          <div className="stats-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            <div className="stat-card">
              <div className="stat-label">Total Runs</div>
              <div className="stat-value">{total}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Succeeded</div>
              <div className="stat-value" style={{ color: "var(--success)" }}>
                {succeeded}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Failed</div>
              <div className="stat-value" style={{ color: "var(--danger)" }}>
                {failed}
              </div>
            </div>
          </div>
        )}

        {/* Workflow structure */}
        {workflow && (
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                Structure
              </div>
              <span className="panel-count">
                {workflow.jobs?.reduce(
                  (n, j) => n + (j.steps?.length ?? 0),
                  0,
                ) ?? 0}{" "}
                steps
              </span>
            </div>
            <div>
              {(workflow.jobs ?? []).map((job) => (
                <div key={job.name}>
                  <div
                    style={{
                      padding: "8px 18px",
                      background: "var(--surface-inset)",
                      fontSize: "0.78rem",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    Job: {job.name}
                    <span
                      className="mono"
                      style={{
                        fontSize: "0.7rem",
                        color: "var(--text-3)",
                        fontWeight: 400,
                        marginLeft: "auto",
                      }}
                    >
                      {job.steps?.length ?? 0} steps
                    </span>
                  </div>
                  {(job.steps ?? []).map((step) => (
                    <div
                      key={step.name}
                      style={{
                        padding: "8px 18px 8px 36px",
                        borderBottom: "1px solid var(--border-subtle)",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: "0.82rem",
                      }}
                    >
                      <span style={{ fontWeight: 500 }}>{step.name}</span>
                      {step.task?.modelIdOrName && (
                        <span
                          className="mono"
                          style={{
                            fontSize: "0.72rem",
                            color: "var(--text-3)",
                          }}
                        >
                          {step.task.modelIdOrName}
                          {step.task.methodName
                            ? `.${step.task.methodName}`
                            : ""}
                        </span>
                      )}
                      <span
                        className="cron-badge"
                        style={{ marginLeft: "auto" }}
                      >
                        {step.task?.type ?? "unknown"}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent runs */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              Run History
              <span className="panel-count">{recentRuns.length}</span>
            </div>
          </div>
          <div>
            {recentRuns.length === 0 && (
              <div className="loading">No runs recorded</div>
            )}
            {recentRuns.map((run) => (
              <div
                className="run-row"
                key={run.runId}
                onClick={() => onOpenRun?.(run.workflowName, run.runId)}
              >
                <StatusDot status={run.status} />
                <div className="run-info">
                  <div className="run-name">{run.runId?.slice(0, 8)}</div>
                  <div className="run-detail">
                    {formatRelativeTime(run.startedAt)}
                  </div>
                </div>
                <span className="run-duration">
                  {formatDuration(run.duration)}
                </span>
                <StatusPill status={run.status} />
              </div>
            ))}
          </div>
        </div>

        {/* Raw definition */}
        {workflow && (
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">Definition</div>
              {workflow.path && (
                <span
                  className="mono"
                  style={{ fontSize: "0.7rem", color: "var(--text-3)" }}
                >
                  {workflow.path}
                </span>
              )}
            </div>
            <CodeBlock code={yaml.dump(workflow, { lineWidth: -1, noRefs: true })} language="yaml" />
          </div>
        )}
      </div>
    </>
  );
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

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
