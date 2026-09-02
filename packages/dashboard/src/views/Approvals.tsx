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

import { useCallback } from "react";
import { useSwamp } from "../client/SwampProvider";
import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
import { StatusPill } from "../components/StatusPill";

interface ApprovalInfo {
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt?: string;
  prompt?: string;
  inputs?: Readonly<Record<string, unknown>>;
}

export function Approvals() {
  const { request } = useSwamp();
  const { data, refetch } = useRequest("workflow.approvals");
  const approvals = extractArray<ApprovalInfo>(data);

  const handleApprove = useCallback(
    async (workflowName: string, stepName: string) => {
      await request("workflow.approve", {
        workflowIdOrName: workflowName,
        stepName,
      });
      refetch();
    },
    [request, refetch],
  );

  const handleReject = useCallback(
    async (workflowName: string, stepName: string) => {
      await request("workflow.reject", {
        workflowIdOrName: workflowName,
        stepName,
      });
      refetch();
    },
    [request, refetch],
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
                    onClick={() => handleApprove(a.workflowName, a.stepName)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-reject"
                    onClick={() => handleReject(a.workflowName, a.stepName)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))
          )}
      </div>
    </>
  );
}
