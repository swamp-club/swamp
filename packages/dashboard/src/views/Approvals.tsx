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

import { useCallback, useState } from "react";
import { useSwamp } from "../client/SwampProvider";
import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
import {
  activeRunIds,
  type ResumableRun,
  resumeStateFor,
} from "../client/resume_state";
import { useActiveRunsRefetch } from "../client/useActiveRunsRefetch";
import type { HealthSnapshot } from "../client/useHealthStream";
import { StatusPill } from "../components/StatusPill";
import { ResumeAction } from "../components/ResumeAction";
import { SignalWaitsPanel } from "../components/SignalWaitsPanel";
import { signalWaitRows } from "../client/signal_wait_state";

interface ApprovalInfo {
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt?: string;
  prompt?: string;
  inputs?: Readonly<Record<string, unknown>>;
  /** On a nested workflow's run, the parent that started it. */
  parentRun?: { workflowName: string; runId: string };
  /** Whether that parent still waits on this run. */
  parentWaiting?: boolean;
}

interface ApprovalsProps {
  /** Serve's live health snapshot; its active runs are runs serve drives. */
  health?: HealthSnapshot | null;
  /** Called after a gate decision or resume, so the sidebar count refreshes. */
  onApprovalsChanged?: () => void;
}

export function Approvals({ health, onApprovalsChanged }: ApprovalsProps) {
  const { request } = useSwamp();
  const { data, refetch } = useRequest("workflow.approvals");
  const { data: suspendedData, refetch: refetchSuspended } = useRequest(
    "workflow.run.search",
    { status: "suspended", limit: 200 },
  );
  // Refused to a caller who may read no workflow: nothing is listed then.
  // Refetched only with the gates, never on a timer: the listing settles
  // expired waits as it reads.
  const { data: waitsData, refetch: refetchWaits } = useRequest(
    "workflow.waits",
    { includeSignalled: true },
  );
  const signalWaits = signalWaitRows(waitsData);
  const approvals = extractArray<ApprovalInfo>(data);
  const suspendedRuns = extractArray<ResumableRun>(suspendedData);
  const awaitingResume = suspendedRuns.filter(
    (run) => resumeStateFor(run) !== null,
  );
  // Runs serve drives now, whoever approved them (swamp-club#3005).
  const servedRuns = activeRunIds(health?.activeRuns);
  const refetchGatesAndRuns = useCallback(() => {
    refetch();
    refetchSuspended();
    refetchWaits();
  }, [refetch, refetchSuspended, refetchWaits]);
  useActiveRunsRefetch(health?.activeRuns, suspendedRuns, refetchGatesAndRuns);
  const [notice, setNotice] = useState<string | null>(null);
  const [resumingRuns, setResumingRuns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const refresh = useCallback(() => {
    refetch();
    refetchSuspended();
    refetchWaits();
    onApprovalsChanged?.();
  }, [refetch, refetchSuspended, refetchWaits, onApprovalsChanged]);

  const [error, setError] = useState<string | null>(null);

  const handleApprove = useCallback(
    async (a: ApprovalInfo) => {
      setError(null);
      setNotice(null);
      try {
        const result = await request<{ data?: { autoResumed?: boolean } }>(
          "workflow.approve",
          {
            workflowIdOrName: a.workflowName,
            stepName: a.stepName,
            runId: a.runId,
          },
        );
        if (result.data?.autoResumed) {
          setResumingRuns((prev) => new Set(prev).add(a.runId));
          setNotice(`${a.workflowName}: approved — serve is resuming the run`);
        }
      } catch (err) {
        setError(
          `Approve failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      refresh();
    },
    [request, refresh],
  );

  const handleReject = useCallback(
    async (a: ApprovalInfo) => {
      setError(null);
      setNotice(null);
      try {
        await request("workflow.reject", {
          workflowIdOrName: a.workflowName,
          stepName: a.stepName,
          runId: a.runId,
        });
      } catch (err) {
        setError(
          `Reject failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      refresh();
    },
    [request, refresh],
  );

  const totalGates = approvals.length;

  return (
    <>
      <div className="page-header">
        <h1>Approvals</h1>
        <div className="header-right">
          {totalGates > 0 && (
            <div
              className="health-pill"
              style={{
                background: "var(--warning-bg)",
                color: "var(--warning)",
              }}
            >
              {totalGates} pending
            </div>
          )}
        </div>
      </div>

      {notice && <div className="resume-label">{notice}</div>}
      {error && <div className="resume-error">{error}</div>}

      <div className="panel">
        {approvals.length === 0
          ? <div className="loading">No pending approvals</div>
          : (
            approvals.map((a) => (
              <div
                className="approval-row"
                key={`${a.runId}-${a.stepName}`}
              >
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
                  <div
                    style={{
                      fontSize: "0.82rem",
                      color: "var(--text-2)",
                      marginTop: 2,
                    }}
                  >
                    Step: <strong>{a.stepName}</strong>
                  </div>
                  {a.prompt && (
                    <div
                      style={{
                        fontSize: "0.78rem",
                        color: "var(--text-3)",
                        marginTop: 2,
                      }}
                    >
                      {a.prompt}
                    </div>
                  )}
                  {a.parentRun && (
                    <div
                      style={{
                        fontSize: "0.78rem",
                        color: "var(--text-3)",
                        marginTop: 2,
                      }}
                    >
                      {a.parentWaiting
                        ? `Nested run of ${a.parentRun.workflowName}: resume the parent after this run finishes`
                        : `Nested run of ${a.parentRun.workflowName}: the parent no longer waits on it`}
                    </div>
                  )}
                </div>
                <div className="approval-actions">
                  <button
                    type="button"
                    className="btn-sm btn-approve"
                    onClick={() => handleApprove(a)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-reject"
                    onClick={() => handleReject(a)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))
          )}
      </div>

      <SignalWaitsPanel
        rows={signalWaits}
        renderResume={(row) => (
          <ResumeAction
            run={{
              runId: row.runId,
              workflowName: row.workflowName,
              status: "suspended",
              awaitingResume: true,
            }}
            onResumed={refresh}
            resuming={resumingRuns.has(row.runId) || servedRuns.has(row.runId)}
            readyBecause="signalled"
          />
        )}
      />

      {awaitingResume.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-header">
            <div className="panel-title">
              Awaiting resume{" "}
              <span className="panel-count">{awaitingResume.length}</span>
            </div>
          </div>
          {awaitingResume.map((run) => (
            <div className="approval-row" key={run.runId}>
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
                  {run.workflowName}
                  <span className="mono" style={{ color: "var(--text-3)" }}>
                    {run.runId.slice(0, 8)}
                  </span>
                </div>
                <ResumeAction
                  run={run}
                  onResumed={refresh}
                  resuming={resumingRuns.has(run.runId) ||
                    servedRuns.has(run.runId)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
