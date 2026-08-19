import { useCallback } from "react";
import { useSwamp } from "../client/SwampProvider";
import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
import { StatusPill } from "../components/StatusPill";

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

  const totalGates = approvals.reduce(
    (n, a) => n + (Array.isArray(a.steps) ? a.steps.length : 0),
    0,
  );

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
            approvals.flatMap((a) =>
              (a.steps ?? []).map((step) => (
                <div
                  className="approval-row"
                  key={`${a.runId}-${step.name}`}
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
                      Step: <strong>{step.name}</strong>
                    </div>
                    {step.prompt && (
                      <div
                        style={{
                          fontSize: "0.78rem",
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
            )
          )}
      </div>
    </>
  );
}
