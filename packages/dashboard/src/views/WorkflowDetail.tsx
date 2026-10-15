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

import { extractArray, extractObject } from "../client/extract.ts";
import { CodeBlock } from "../components/CodeBlock.tsx";
import * as yaml from "js-yaml";
import { useRequest } from "../client/useRequest.ts";
import { StatusDot } from "../components/StatusDot.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { TriggerBadge } from "../components/TriggerBadge.tsx";
import "../styles/workflows.css";
import { RouteLink } from "../components/RouteLink.tsx";
import { FailureLink } from "../components/FailureLink.tsx";
import { RunHistoryBar } from "../components/RunHistoryBar.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  SkeletonList,
  SkeletonPanel,
  SkeletonRunHistory,
  SkeletonStats,
} from "../components/Skeleton.tsx";
import {
  formatAbsoluteTime,
  formatCount,
  formatDuration,
  formatRelativeTime,
} from "../lib/format.ts";

interface WorkflowDetailProps {
  workflowName: string;
  onBack: () => void;
  onOpenRun?: (workflowName: string, runId?: string) => void;
}

interface RunSummary {
  runId: string;
  workflowName: string;
  status: string;
  startedAt?: string;
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
  const { data: wfData, loading: wfLoading } = useRequest("workflow.get", {
    workflowIdOrName: workflowName,
  });
  const { data: runsData, loading: runsLoading } = useRequest(
    "workflow.run.search",
    {
      workflow: workflowName,
      limit: 20,
    },
  );
  const runsPending = runsLoading && runsData === null;

  const workflow = extractObject<WorkflowData>(wfData);
  const recentRuns = extractArray<RunSummary>(runsData);

  const succeeded = recentRuns.filter((r) => r.status === "succeeded").length;
  const failed = recentRuns.filter((r) => r.status === "failed").length;
  const total = recentRuns.length;

  return (
    <>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" className="back-button" onClick={onBack}>
            &larr; Back
          </button>
          <h1>{workflowName}</h1>
          {workflow?.trigger?.schedule && <TriggerBadge trigger="schedule" />}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Stats row */}
        {runsPending && <SkeletonStats count={3} />}
        {total > 0 && (
          <div
            className="stats-grid"
            style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
          >
            <div className="stat-card">
              <div className="stat-label">Total Runs</div>
              <div className="stat-value">{formatCount(total)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Succeeded</div>
              <div className="stat-value" style={{ color: "var(--success)" }}>
                {formatCount(succeeded)}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Failed</div>
              <div className="stat-value" style={{ color: "var(--danger)" }}>
                {formatCount(failed)}
              </div>
            </div>
          </div>
        )}

        {/* Workflow structure */}
        {!workflow && wfLoading && (
          <SkeletonPanel title="Structure" rows={4} label="Loading workflow" />
        )}
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
                ) ?? 0} steps
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
              {!runsPending && (
                <span className="panel-count">
                  {formatCount(recentRuns.length)}
                </span>
              )}
            </div>
          </div>
          {recentRuns.length > 0 && (
            <div className="wf-detail-history">
              <RunHistoryBar runs={recentRuns} workflowName={workflowName} />
            </div>
          )}
          {runsPending && (
            <>
              <div className="wf-detail-history">
                <SkeletonRunHistory height={14} />
              </div>
              <SkeletonList rows={5} label="Loading runs" />
            </>
          )}
          <div className="wf-detail-runs">
            {!runsPending && recentRuns.length === 0 && (
              <EmptyState title="No runs yet">
                Runs of this workflow will appear here.
              </EmptyState>
            )}
            {recentRuns.map((run) => (
              <div
                className="run-row"
                key={run.runId}
                onClick={(e) => {
                  // The run link handles its own clicks.
                  if ((e.target as Element).closest("a")) return;
                  onOpenRun?.(run.workflowName, run.runId);
                }}
              >
                <StatusDot status={run.status} />
                <div className="run-info">
                  <div className="run-name">
                    <RouteLink
                      className="wf-detail-run-link mono"
                      to={{
                        view: "workflows",
                        detail: {
                          kind: "run",
                          workflowName: run.workflowName,
                          runId: run.runId,
                        },
                      }}
                    >
                      {run.runId?.slice(0, 8)}
                    </RouteLink>
                  </div>
                  {run.startedAt && (
                    <time
                      className="run-detail"
                      dateTime={run.startedAt}
                      title={formatAbsoluteTime(run.startedAt)}
                    >
                      {formatRelativeTime(run.startedAt)}
                    </time>
                  )}
                </div>
                {run.status === "failed"
                  ? (
                    <FailureLink
                      workflowName={run.workflowName}
                      runId={run.runId}
                    />
                  )
                  : <span />}
                <span className="run-duration">
                  {run.duration !== undefined
                    ? formatDuration(run.duration)
                    : ""}
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
            <CodeBlock
              code={yaml.dump(workflow, { lineWidth: -1, noRefs: true })}
              language="yaml"
            />
          </div>
        )}
      </div>
    </>
  );
}
