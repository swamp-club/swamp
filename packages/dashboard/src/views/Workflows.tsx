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

import { useState } from "react";
import { useRequest } from "../client/useRequest";
import { extractArray, extractTotal } from "../client/extract";
import { StatusPill } from "../components/StatusPill";
import { TriggerBadge } from "../components/TriggerBadge";
import { Pager } from "../components/Pager";
import { RunHistoryBar } from "../components/RunHistoryBar";

interface WorkflowDef {
  id: string;
  name: string;
  trigger?: { schedule?: string };
  stepCount: number;
}

interface RunSummary {
  runId: string;
  workflowName: string;
  status: string;
  startedAt?: string;
  triggerSource?: string;
}

interface WorkflowsProps {
  onOpenWorkflow?: (workflowName: string) => void;
}

const PAGE_SIZE = 50;

export function Workflows({ onOpenWorkflow }: WorkflowsProps) {
  const [page, setPage] = useState(0);
  const { data: workflowsData } = useRequest("workflow.search", {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  // One search at serve's default page size rather than one per card:
  // serve reads every run file for any run search, filtered or not.
  const { data: runsData } = useRequest("workflow.run.search", {});

  const workflows = extractArray<WorkflowDef>(workflowsData);
  const workflowTotal = extractTotal(workflowsData) ?? workflows.length;
  const runs = extractArray<RunSummary>(runsData);

  const runsByWorkflow = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const list = runsByWorkflow.get(run.workflowName) ?? [];
    list.push(run);
    runsByWorkflow.set(run.workflowName, list);
  }

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
            {workflowTotal} workflows
          </div>
        </div>
      </div>

      <div className="card-grid">
        {workflows.map((w) => {
          const wRuns = runsByWorkflow.get(w.name) ?? [];
          const lastRun = wRuns[0];

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
                <span>{w.stepCount} steps</span>
              </div>
              <div style={{ marginTop: 12 }}>
                <RunHistoryBar runs={wRuns} workflowName={w.name} />
              </div>
            </div>
          );
        })}
      </div>

      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        total={workflowTotal}
        onPageChange={setPage}
      />
    </>
  );
}
