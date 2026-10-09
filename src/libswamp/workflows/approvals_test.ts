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
  type WorkflowApprovalsData,
  type WorkflowApprovalsDeps,
  type WorkflowApprovalsEvent,
} from "./approvals.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";

const WF_ID = "550e8400-e29b-41d4-a716-446655440000" as unknown as WorkflowId;
const PARENT_WF_ID =
  "660e8400-e29b-41d4-a716-446655440000" as unknown as WorkflowId;
const PARENT_RUN_ID = "770e8400-e29b-41d4-a716-446655440000";
const CHILD_RUN_ID = "880e8400-e29b-41d4-a716-446655440000";

function makeWorkflow(overrides?: {
  id?: WorkflowId;
  name?: string;
  stepType?: string;
  timeout?: number;
  prompt?: string;
}): Workflow {
  const stepTask = overrides?.stepType === "manual_approval"
    ? {
      type: "manual_approval" as const,
      prompt: overrides?.prompt ?? "Approve deployment",
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
  inputs?: Record<string, unknown>;
  approvalPrompt?: string;
  instanceId?: string;
  parentRun?: Record<string, unknown>;
  stepName?: string;
  approvalTimeout?: number;
  forEachTemplate?: string;
}): WorkflowRun {
  const stepStatus = overrides?.stepStatus ?? "waiting_approval";
  const startedAt = overrides?.startedAt ?? new Date();
  const inputs = overrides?.inputs ?? {};
  const approvalPrompt = overrides?.approvalPrompt;
  const stepName = overrides?.stepName ?? "gate";
  return {
    id: overrides?.id ?? "run-1",
    status: overrides?.status ?? "suspended",
    inputs,
    instanceId: overrides?.instanceId,
    parentRun: overrides?.parentRun
      ? { kind: "valid", ref: overrides.parentRun }
      : undefined,
    findWaitingApprovalStep: () =>
      stepStatus === "waiting_approval"
        ? { jobName: "main", stepName }
        : undefined,
    getJob: (name: string) =>
      name === "main"
        ? {
          getStep: (sn: string) =>
            sn === stepName
              ? {
                stepName,
                startedAt,
                status: stepStatus,
                approvalPrompt,
                approvalTimeout: overrides?.approvalTimeout,
                forEachTemplate: overrides?.forEachTemplate,
              }
              : undefined,
        }
        : undefined,
  } as unknown as WorkflowRun;
}

function makeDeps(
  workflows: Workflow[],
  runsByWorkflow: Map<string, WorkflowRun[]>,
  evaluatedWorkflows?: Map<string, Workflow>,
): WorkflowApprovalsDeps {
  return {
    workflowRepo: {
      findAll: () => Promise.resolve(workflows),
    } as WorkflowApprovalsDeps["workflowRepo"],
    runRepo: {
      findAllByWorkflowId: (id: WorkflowId) =>
        Promise.resolve(runsByWorkflow.get(id as string) ?? []),
    } as WorkflowApprovalsDeps["runRepo"],
    findEvaluatedWorkflow: evaluatedWorkflows
      ? (id: WorkflowId) =>
        Promise.resolve(evaluatedWorkflows.get(id as string) ?? null)
      : undefined,
  };
}

const ctx = createLibSwampContext();

async function completedData(
  deps: WorkflowApprovalsDeps,
): Promise<WorkflowApprovalsData> {
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error(`no completed event: ${JSON.stringify(events)}`);
  }
  return completed.data;
}

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

Deno.test("workflowApprovals: includes run inputs in pending approval", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const run = makeRun({
    id: "run-with-inputs",
    inputs: { environment: "prod", region: "us-west-2" },
  });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 1);
    assertEquals(completed.data.approvals[0].inputs, {
      environment: "prod",
      region: "us-west-2",
    });
  }
});

Deno.test("workflowApprovals: returns empty inputs when run has no inputs", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const run = makeRun({ id: "run-no-inputs" });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 1);
    assertEquals(completed.data.approvals[0].inputs, {});
  }
});

Deno.test("workflowApprovals: lists a gate past its timeout as expired, not pending", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval", timeout: 60 });
  const suspendedAt = new Date(Date.now() - 120_000);
  const run = makeRun({ startedAt: suspendedAt });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));

  const data = await completedData(deps);

  assertEquals(data.approvals, []);
  assertEquals(data.expired, [{
    workflowId: WF_ID as string,
    workflowName: "test-workflow",
    runId: "run-1",
    stepName: "gate",
    suspendedAt: suspendedAt.toISOString(),
    timeoutSeconds: 60,
    expiredAt: new Date(suspendedAt.getTime() + 60_000).toISOString(),
    serveStarted: false,
  }]);
});

Deno.test("workflowApprovals: lists a forEach-expanded gate past its timeout as expired, not pending", async () => {
  // The definition has no step named as the expanded step run is.
  const wf = makeWorkflow({ stepType: "manual_approval", timeout: 60 });
  const suspendedAt = new Date(Date.now() - 120_000);
  const run = makeRun({
    startedAt: suspendedAt,
    stepName: "approve-prod",
    approvalTimeout: 60,
    forEachTemplate: "gate",
  });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));

  const data = await completedData(deps);

  assertEquals(data.approvals, []);
  assertEquals(
    data.expired.map((e) => [e.stepName, e.timeoutSeconds, e.expiredAt]),
    [[
      "approve-prod",
      60,
      new Date(suspendedAt.getTime() + 60_000).toISOString(),
    ]],
  );
});

Deno.test("workflowApprovals: a forEach-expanded gate suspended before the step run held its timeout expires by the step it was expanded from", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval", timeout: 60 });
  const run = makeRun({
    startedAt: new Date(Date.now() - 120_000),
    stepName: "approve-prod",
    forEachTemplate: "gate",
  });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));

  const data = await completedData(deps);

  assertEquals(data.approvals, []);
  assertEquals(data.expired.map((e) => e.stepName), ["approve-prod"]);
});

Deno.test("workflowApprovals: the timeout a gate was requested with wins over the definition's", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval", timeout: 3600 });
  const run = makeRun({
    startedAt: new Date(Date.now() - 120_000),
    approvalTimeout: 60,
  });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));

  const data = await completedData(deps);

  assertEquals(data.approvals, []);
  assertEquals(data.expired.map((e) => e.timeoutSeconds), [60]);
});

Deno.test("workflowApprovals: a gate inside its timeout stays pending", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval", timeout: 3600 });
  const run = makeRun({ startedAt: new Date(Date.now() - 120_000) });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));

  const data = await completedData(deps);

  assertEquals(data.approvals.map((a) => a.runId), ["run-1"]);
  assertEquals(data.expired, []);
});

Deno.test("workflowApprovals: a gate with no timeout never expires", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const run = makeRun({ startedAt: new Date(0) });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));

  const data = await completedData(deps);

  assertEquals(data.approvals.map((a) => a.runId), ["run-1"]);
  assertEquals(data.expired, []);
});

Deno.test("workflowApprovals: an expired gate on a run serve started is marked serveStarted", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval", timeout: 60 });
  const run = makeRun({
    startedAt: new Date(Date.now() - 120_000),
    instanceId: "serve-1",
  });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));

  const data = await completedData(deps);

  assertEquals(data.expired.map((e) => e.serveStarted), [true]);
});

Deno.test("workflowApprovals: an expired gate on a nested run names its parent and whether it still waits", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval", timeout: 60 });
  const parentRef = {
    workflowId: PARENT_WF_ID as string,
    workflowName: "parent",
    runId: PARENT_RUN_ID,
    jobName: "main",
    stepName: "call-child",
    ancestorWorkflowNames: [],
  };
  const child = makeRun({
    id: CHILD_RUN_ID,
    startedAt: new Date(Date.now() - 120_000),
    parentRun: parentRef,
  });
  const parent = {
    id: PARENT_RUN_ID,
    status: "suspended",
    instanceId: "serve-1",
    getJob: () => ({
      getStep: () => ({
        isNestedWait: true,
        nestedRun: { kind: "valid", ref: { runId: CHILD_RUN_ID } },
      }),
    }),
  } as unknown as WorkflowRun;
  const deps = makeDeps([wf], new Map([[WF_ID as string, [child]]]));
  deps.runRepo = {
    ...deps.runRepo,
    findById: (_workflowId: WorkflowId, runId: string) =>
      Promise.resolve(runId === PARENT_RUN_ID ? parent : null),
  } as WorkflowApprovalsDeps["runRepo"];

  const data = await completedData(deps);

  assertEquals(data.expired.length, 1);
  assertEquals(data.expired[0].parentRun, {
    workflowId: PARENT_WF_ID as string,
    workflowName: "parent",
    runId: PARENT_RUN_ID,
    stepName: "call-child",
    serveStarted: true,
  });
  assertEquals(data.expired[0].parentWaiting, true);
});

Deno.test("workflowApprovals: returns evaluated prompt when evaluated workflow exists", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const evaluatedWf = makeWorkflow({
    stepType: "manual_approval",
    prompt: "Approve deployment to production v2.0",
  });
  const run = makeRun({ id: "run-eval" });
  const evaluatedWorkflows = new Map([[WF_ID as string, evaluatedWf]]);
  const deps = makeDeps(
    [wf],
    new Map([[WF_ID as string, [run]]]),
    evaluatedWorkflows,
  );
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 1);
    assertEquals(
      completed.data.approvals[0].prompt,
      "Approve deployment to production v2.0",
    );
  }
});

Deno.test("workflowApprovals: falls back to raw prompt when no evaluated workflow exists", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const run = makeRun({ id: "run-fallback" });
  const evaluatedWorkflows = new Map<string, Workflow>();
  const deps = makeDeps(
    [wf],
    new Map([[WF_ID as string, [run]]]),
    evaluatedWorkflows,
  );
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 1);
    assertEquals(completed.data.approvals[0].prompt, "Approve deployment");
  }
});

Deno.test("workflowApprovals: falls back to raw prompt when findEvaluatedWorkflow throws", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const run = makeRun({ id: "run-error" });
  const deps = makeDeps([wf], new Map([[WF_ID as string, [run]]]));
  deps.findEvaluatedWorkflow = () =>
    Promise.reject(new Error("Corrupted YAML"));
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 1);
    assertEquals(completed.data.approvals[0].prompt, "Approve deployment");
  }
});

Deno.test("workflowApprovals: each suspended run shows its own resolved prompt", async () => {
  const wf = makeWorkflow({
    stepType: "manual_approval",
    prompt: "Approval marker: ${{ inputs.label }}",
  });
  const runOne = makeRun({
    id: "run-marker-one",
    inputs: { label: "marker-one" },
    approvalPrompt: "Approval marker: marker-one",
  });
  const runTwo = makeRun({
    id: "run-marker-two",
    inputs: { label: "marker-two" },
    approvalPrompt: "Approval marker: marker-two",
  });
  const evaluatedWf = makeWorkflow({
    stepType: "manual_approval",
    prompt: "Approval marker: marker-two",
  });
  const evaluatedWorkflows = new Map([[WF_ID as string, evaluatedWf]]);
  const deps = makeDeps(
    [wf],
    new Map([[WF_ID as string, [runOne, runTwo]]]),
    evaluatedWorkflows,
  );
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 2);
    const approvalOne = completed.data.approvals.find((a) =>
      a.runId === "run-marker-one"
    );
    const approvalTwo = completed.data.approvals.find((a) =>
      a.runId === "run-marker-two"
    );
    assertEquals(approvalOne?.prompt, "Approval marker: marker-one");
    assertEquals(approvalTwo?.prompt, "Approval marker: marker-two");
  }
});

Deno.test("workflowApprovals: falls back to evaluated workflow prompt for runs without approvalPrompt", async () => {
  const wf = makeWorkflow({ stepType: "manual_approval" });
  const run = makeRun({ id: "run-legacy" });
  const evaluatedWf = makeWorkflow({
    stepType: "manual_approval",
    prompt: "Evaluated prompt value",
  });
  const evaluatedWorkflows = new Map([[WF_ID as string, evaluatedWf]]);
  const deps = makeDeps(
    [wf],
    new Map([[WF_ID as string, [run]]]),
    evaluatedWorkflows,
  );
  const events = await collect<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.approvals.length, 1);
    assertEquals(completed.data.approvals[0].prompt, "Evaluated prompt value");
  }
});
