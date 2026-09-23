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
import { type ResumableRun, resumeStateFor } from "../client/resume_state";
import { StatusPill } from "../components/StatusPill";
import { ResumeAction } from "../components/ResumeAction";

interface ApprovalInfo {
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt?: string;
  prompt?: string;
  inputs?: Readonly<Record<string, unknown>>;
}

interface ApprovalsProps {
  /** Called after a gate decision or resume, so the sidebar count refreshes. */
  onApprovalsChanged?: () => void;
}

export function Approvals({ onApprovalsChanged }: ApprovalsProps) {
  const { request } = useSwamp();
  const { data, refetch } = useRequest("workflow.approvals");
  const { data: suspendedData, refetch: refetchSuspended } = useRequest(
    "workflow.run.search",
    { status: "suspended", limit: 200 },
  );
  const approvals = extractArray<ApprovalInfo>(data);
  const awaitingResume = extractArray<ResumableRun>(suspendedData).filter(
    (run) => resumeStateFor(run) !== null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    refetch();
    refetchSuspended();
    onApprovalsChanged?.();
  }, [refetch, refetchSuspended, onApprovalsChanged]);

  const [error, setError] = useState<string | null>(null);

  const handleApprove = useCallback(
    async (a: ApprovalInfo) => {
      setError(null);
      try {
        const result = await request<{ data?: { autoResumed?: boolean } }>(
          "workflow.approve",
          {
            workflowIdOrName: a.workflowName,
            stepName: a.stepName,
            runId: a.runId,
          },
        );
        setNotice(
          result.data?.autoResumed
            ? `${a.workflowName}: approved — serve is resuming the run`
            : null,
        );
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
      try {
        await request("workflow.reject", {
          workflowIdOrName: a.workflowName,
          stepName: a.stepName,
          runId: a.runId,
        });
        setNotice(null);
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
                <ResumeAction run={run} onResumed={refresh} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
