import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
import { StatusPill } from "../components/StatusPill";
import { TriggerBadge } from "../components/TriggerBadge";

interface WorkflowDef {
  id: string;
  name: string;
  trigger?: { schedule?: string };
  jobs: Array<{ steps: Array<unknown> }>;
}

interface RunSummary {
  runId: string;
  workflowName: string;
  status: string;
  triggerSource?: string;
}

interface WorkflowsProps {
  onOpenRun?: (workflowName: string, runId?: string) => void;
  onOpenWorkflow?: (workflowName: string) => void;
}

export function Workflows({ onOpenRun, onOpenWorkflow }: WorkflowsProps) {
  const { data: workflowsData } = useRequest("workflow.search");
  const { data: runsData } = useRequest("workflow.run.search", { limit: 200 });

  const workflows = extractArray<WorkflowDef>(workflowsData);
  const runs = extractArray<RunSummary>(runsData);

  const runsByWorkflow = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const list = runsByWorkflow.get(run.workflowName) ?? [];
    list.push(run);
    runsByWorkflow.set(run.workflowName, list);
  }

  const stepCount = (w: WorkflowDef) =>
    w.jobs?.reduce((n, j) => n + (j.steps?.length ?? 0), 0) ?? 0;

  return (
    <>
      <div className="page-header">
        <h1>Workflows</h1>
        <div className="header-right">
          <div
            className="health-pill"
            style={{
              background: "var(--surface)",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
            }}
          >
            {workflows.length} workflows
          </div>
        </div>
      </div>

      <div className="card-grid">
        {workflows.map((w) => {
          const wRuns = runsByWorkflow.get(w.name) ?? [];
          const lastRun = wRuns[0];
          const succeeded = wRuns.filter((r) =>
            r.status === "succeeded"
          ).length;
          const failed = wRuns.filter((r) => r.status === "failed").length;
          const total = wRuns.length || 1;

          return (
            <div
              className="card"
              key={w.id}
              onClick={() => onOpenWorkflow?.(w.name)}
            >
              <div className="card-header">
                <span className="card-name">{w.name}</span>
                {lastRun && <StatusPill status={lastRun.status} />}
              </div>
              <div className="card-meta">
                {w.trigger?.schedule && (
                  <>
                    <TriggerBadge trigger="schedule" />
                    <span>{w.trigger.schedule}</span>
                  </>
                )}
                {!w.trigger?.schedule && <TriggerBadge trigger="manual" />}
                <span>{stepCount(w)} steps</span>
              </div>
              <div className="ratio-bar" style={{ marginTop: 12 }}>
                <div
                  className="ratio-seg success"
                  style={{ width: `${(succeeded / total) * 100}%` }}
                />
                <div
                  className="ratio-seg failure"
                  style={{ width: `${(failed / total) * 100}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
