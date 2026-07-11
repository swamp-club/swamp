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

import { assertEquals } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowApprovals,
  type WorkflowApprovalsDeps,
  type WorkflowApprovalsEvent,
} from "./approvals.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";

const WF_ID = "550e8400-e29b-41d4-a716-446655440000" as unknown as WorkflowId;

function makeWorkflow(overrides?: {
  id?: WorkflowId;
  name?: string;
  stepType?: string;
  timeout?: number;
}): Workflow {
  const stepTask = overrides?.stepType === "manual_approval"
    ? {
      type: "manual_approval" as const,
      prompt: "Approve deployment",
      timeout: overrides?.timeout,
    }
    : { type: "model_method" as const, modelIdOrName: "m", methodName: "run" };
  return {
    id: overrides?.id ?? WF_ID,
    name: overrides?.name ?? "test-workflow",
    version: 1,
    tags: {},
    jobs: [{
      name: "main",
      description: "",
      steps: [{
        name: "gate",
        description: "",
        task: { data: stepTask, toData: () => stepTask },
        dependsOn: [],
        weight: 0,
        allowFailure: false,
      }],
      dependsOn: [],
      weight: 0,
      getDependencyNames: () => [],
    }],
  } as unknown as Workflow;
}

function makeRun(overrides?: {
  id?: string;
  status?: string;
  stepStatus?: string;
  startedAt?: Date;
}): WorkflowRun {
  const stepStatus = overrides?.stepStatus ?? "waiting_approval";
  const startedAt = overrides?.startedAt ?? new Date();
  return {
    id: overrides?.id ?? "run-1",
    status: overrides?.status ?? "suspended",
    findWaitingApprovalStep: () =>
      stepStatus === "waiting_approval"
        ? { jobName: "main", stepName: "gate" }
        : undefined,
    getJob: (name: string) =>
      name === "main"
        ? {
          getStep: (sn: string) =>
            sn === "gate" ? { startedAt, status: stepStatus } : undefined,
        }
        : undefined,
  } as unknown as WorkflowRun;
}

function makeDeps(
  workflows: Workflow[],
  runsByWorkflow: Map<string, WorkflowRun[]>,
): WorkflowApprovalsDeps {
  return {
    workflowRepo: {
      findAll: () => Promise.resolve(workflows),
    } as WorkflowApprovalsDeps["workflowRepo"],
    runRepo: {
      findAllByWorkflowId: (id: WorkflowId) =>
        Promise.resolve(runsByWorkflow.get(id as string) ?? []),
    } as WorkflowApprovalsDeps["runRepo"],
  };
}

const ctx = createLibSwampContext();

Deno.test("workflowApprovals: returns empty list when no workflows exist", async () => {
  const deps = makeDeps([], new Map());
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals, []);
  }
});

Deno.test("workflowApprovals: skips runs that are not suspended", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const run = makeRun({ status: "running" });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 0);
  }
});

Deno.test("workflowApprovals: skips suspended runs without waiting_approval step", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const run = makeRun({ stepStatus: "succeeded" });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 0);
  }
});

Deno.test("workflowApprovals: returns pending approval for suspended run with waiting_approval step", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const run = makeRun({ id: "run-abc" });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 1);
    assertEquals(completed.data.approvals[0].workflowName, "test-workflow");
    assertEquals(completed.data.approvals[0].runId, "run-abc");
    assertEquals(completed.data.approvals[0].stepName, "gate");
    assertEquals(completed.data.approvals[0].prompt, "Approve deployment");
  }
});

Deno.test("workflowApprovals: filters out expired approval timeouts", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval", timeout: 60 });
  const twoMinutesAgo = new Date(Date.now() - 120_000);
  const run = makeRun({ startedAt: twoMinutesAgo });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 0);
  }
});
