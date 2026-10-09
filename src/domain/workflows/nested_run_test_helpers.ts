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

import { Job } from "./job.ts";
import type { SignalWait } from "./signal_wait.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import type { WorkflowId, WorkflowRunId } from "./workflow_id.ts";
import { WorkflowRun } from "./workflow_run.ts";

/** Run records by id, counting saves, for tests of linked nested runs. */
export class InMemoryRuns {
  readonly byId = new Map<string, WorkflowRun>();
  readonly saved: string[] = [];
  /** Run ids whose read throws. */
  readonly unreadable = new Set<string>();

  add(...runs: WorkflowRun[]): void {
    for (const run of runs) this.byId.set(run.id.toLowerCase(), run);
  }

  findById(
    _workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null> {
    if (this.unreadable.has(runId.toLowerCase())) {
      return Promise.reject(new Error("run record unreadable"));
    }
    // A fresh copy each read, as a repository gives.
    const run = this.byId.get(runId.toLowerCase());
    return Promise.resolve(run ? WorkflowRun.fromData(run.toData()) : null);
  }

  save(_workflowId: WorkflowId, run: WorkflowRun): Promise<void> {
    this.saved.push(run.id);
    this.byId.set(run.id.toLowerCase(), WorkflowRun.fromData(run.toData()));
    return Promise.resolve();
  }

  /** The stored run, read back. */
  get(run: { id: string }): WorkflowRun {
    const found = this.byId.get(run.id.toLowerCase());
    if (!found) throw new Error(`no run ${run.id}`);
    return found;
  }
}

/** Workflows by id. */
export class InMemoryWorkflows {
  readonly byId = new Map<string, Workflow>();
  add(...workflows: Workflow[]): void {
    for (const workflow of workflows) this.byId.set(workflow.id, workflow);
  }
  findById(id: WorkflowId): Promise<Workflow | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
}

/** A workflow whose one step calls `callee`, or a gate when there is none. */
export function chainWorkflow(name: string, callee?: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "step",
            task: callee
              ? StepTask.workflow(callee)
              : StepTask.manualApproval("Approve"),
          }),
        ],
      }),
    ],
  });
}

/** Runs suspended one inside the next, linked both ways. */
export interface NestedChain {
  /** Outermost first: `runs[0]` is the top parent, the last one holds the gate. */
  chain: WorkflowRun[];
  workflows: Workflow[];
  runs: InMemoryRuns;
  workflowRepo: InMemoryWorkflows;
}

/**
 * Builds `levels` runs (at least 2), each suspended on the next through its
 * `step`, the innermost suspended at a manual approval gate. Every run is
 * stored. The returned `chain` holds the objects that were stored, so a test
 * that changes one stores it again with `runs.add`. With `signalWait`, the
 * innermost run waits for a signal on it instead.
 */
export function nestedChain(
  levels = 2,
  signalWait?: SignalWait,
): NestedChain {
  const workflows: Workflow[] = [];
  for (let i = 0; i < levels; i++) {
    workflows.push(
      chainWorkflow(`wf-${i}`, i < levels - 1 ? `wf-${i + 1}` : undefined),
    );
  }
  const chain: WorkflowRun[] = [];
  for (let i = 0; i < levels; i++) {
    const run = WorkflowRun.create(workflows[i], undefined, "user:alice");
    if (i > 0) {
      run.recordParentRun({
        workflowId: workflows[i - 1].id,
        workflowName: workflows[i - 1].name,
        runId: chain[i - 1].id,
        jobName: "main",
        stepName: "step",
        nestingDepth: i,
        ancestorWorkflowNames: workflows.slice(0, i).map((w) => w.name),
      });
    }
    run.start();
    run.getJob("main")!.start();
    run.getJob("main")!.getStep("step")!.start();
    chain.push(run);
  }
  // Suspend from the innermost outward, as the runs would.
  for (let i = levels - 1; i >= 0; i--) {
    const step = chain[i].getJob("main")!.getStep("step")!;
    if (i === levels - 1 && signalWait) {
      step.waitForSignal(signalWait);
    } else if (i === levels - 1) {
      step.waitForApproval("Approve");
    } else {
      step.waitForNestedRun({
        workflowId: workflows[i + 1].id,
        workflowName: workflows[i + 1].name,
        runId: chain[i + 1].id,
      });
    }
    chain[i].suspend();
  }
  const runs = new InMemoryRuns();
  runs.add(...chain);
  const workflowRepo = new InMemoryWorkflows();
  workflowRepo.add(...workflows);
  return { chain, workflows, runs, workflowRepo };
}
