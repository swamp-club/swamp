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

/**
 * Integration tests for a nested workflow that suspends on a manual approval
 * gate (swamp-club#2736): the parent suspends on the child run, the child is
 * approved, rejected, resumed or cancelled as a run of its own, and the
 * parent's resume reads the child's outcome. Everything runs on real YAML
 * repositories and the per-workflow run index, through the libswamp
 * operations the CLI and serve call.
 */

import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type StepExecutionContext,
  type StepExecutor,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import type { WorkflowExecutionEvent } from "../src/domain/workflows/execution_events.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { NestedRunPendingError } from "../src/domain/workflows/nested_run_link.ts";
import { UserError } from "../src/domain/errors.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowApprovalsDeps,
  createWorkflowApproveDeps,
  createWorkflowCancelSuspendedDeps,
  createWorkflowRejectDeps,
  supersedeSuspendedRuns,
  workflowApprovals,
  type WorkflowApprovalsData,
  workflowApprove,
  type WorkflowApproveData,
  workflowCancelSuspended,
  type WorkflowCancelSuspendedData,
  workflowReject,
  type WorkflowRejectData,
  workflowRunSearch,
  type WorkflowRunSearchItem,
} from "../src/libswamp/mod.ts";
import { nestedWaitView } from "../src/libswamp/workflows/history_get.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { unclaimedRuns } from "../src/domain/workflows/run_claim.ts";

await initializeLogging({});

class RecordingExecutor implements StepExecutor {
  readonly executed: string[] = [];
  execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
    this.executed.push(`${ctx.workflowName}/${ctx.stepName}`);
    return Promise.resolve({ step: ctx.stepName });
  }
}

interface Harness {
  repoDir: string;
  workflowRepo: YamlWorkflowRepository;
  runRepo: YamlWorkflowRunRepository;
  service: WorkflowExecutionService;
  executor: RecordingExecutor;
}

async function withHarness(
  workflows: Workflow[],
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-nested-gate-" });
  const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    for (const workflow of workflows) await workflowRepo.save(workflow);
    const runRepo = new YamlWorkflowRunRepository(repoDir);
    const executor = new RecordingExecutor();
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      repoDir,
      executor,
      undefined,
      catalogStore,
    );
    await fn({ repoDir, workflowRepo, runRepo, service, executor });
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function gatedChild(name = "gated-child"): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "child-job",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve the child"),
          }),
          Step.create({
            name: "after-gate",
            task: StepTask.model("test-model", "run"),
            dependsOn: [{
              step: "gate",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      }),
    ],
  });
}

function caller(name: string, callee: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call-nested",
            task: StepTask.workflow(callee),
          }),
          Step.create({
            name: "after-nested",
            task: StepTask.model("test-model", "run"),
            dependsOn: [{
              step: "call-nested",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      }),
    ],
  });
}

async function drain(
  stream: AsyncIterable<WorkflowExecutionEvent>,
): Promise<WorkflowExecutionEvent[]> {
  const events: WorkflowExecutionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function only(
  runRepo: YamlWorkflowRunRepository,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const runs = await runRepo.findAllByWorkflowId(workflow.id);
  assertEquals(runs.length, 1);
  return runs[0];
}

async function completed<T>(
  stream: AsyncIterable<
    { kind: string; data?: T; error?: { message: string } }
  >,
): Promise<T> {
  for await (const event of stream) {
    if (event.kind === "completed") return event.data as T;
    if (event.kind === "error") throw new Error(event.error!.message);
  }
  throw new Error("no completed event");
}

async function searchRuns(h: Harness): Promise<WorkflowRunSearchItem[]> {
  const data = await completed<{ results: WorkflowRunSearchItem[] }>(
    workflowRunSearch(createLibSwampContext(), {
      findAllWorkflows: () => h.workflowRepo.findAll(),
      findAllRunsByWorkflowId: (id) =>
        h.runRepo.findAllSummariesFromIndex(createWorkflowId(id)),
    }, {}),
  );
  return data.results;
}

Deno.test("nested approval: the parent suspends, the child is approved and resumed on its own run, then the parent adopts it", async () => {
  const child = gatedChild();
  const parent = caller("waiting-parent", child.name);
  await withHarness([parent, child], async (h) => {
    const events = await drain(h.service.run(parent.name));
    const parentRun = await only(h.runRepo, parent);
    const childRun = await only(h.runRepo, child);
    assertEquals(parentRun.status, "suspended");
    assertEquals(childRun.status, "suspended");
    const terminal = events.filter((e) =>
      e.kind === "suspended" || e.kind === "completed"
    );
    assertEquals(terminal.length, 1);
    assert(terminal[0].kind === "suspended");
    assertEquals(terminal[0].run.id, parentRun.id);

    // Only the child has a gate to decide; its row names the waiting parent.
    const approvals = await completed<WorkflowApprovalsData>(
      workflowApprovals(
        createLibSwampContext(),
        createWorkflowApprovalsDeps(h.workflowRepo, h.runRepo),
      ),
    );
    assertEquals(approvals.approvals.map((a) => a.runId), [childRun.id]);
    assertEquals(approvals.approvals[0].parentRun?.runId, parentRun.id);
    assertEquals(approvals.approvals[0].parentWaiting, true);

    // Resuming the parent first is refused and changes nothing.
    await assertRejects(
      () => drain(h.service.resume(parent.name, parentRun.id)),
      NestedRunPendingError,
    );

    const approved = await completed<WorkflowApproveData>(
      workflowApprove(
        createLibSwampContext(),
        createWorkflowApproveDeps(h.workflowRepo, h.runRepo, unclaimedRuns),
        { workflowIdOrName: child.name, stepName: "gate", runId: childRun.id },
      ),
    );
    assertEquals(approved.allGatesDecided, true);
    assertEquals(approved.awaitingParent?.runId, parentRun.id);
    assertStringIncludes(
      approved.awaitingParent!.resumeCommand,
      `swamp workflow resume ${parent.name} --run ${parentRun.id}`,
    );

    // Still waiting: the parent is not resumable until the child finishes.
    let parentRow = (await searchRuns(h)).find((r) =>
      r.runId === parentRun.id
    )!;
    assertEquals(parentRow.awaitingResume, undefined);
    assertEquals(parentRow.nestedWaits?.[0].runId, childRun.id);

    await drain(h.service.resume(child.name, childRun.id));
    assertEquals((await only(h.runRepo, child)).status, "succeeded");

    // Derived from the child, read from the index this time.
    parentRow = (await searchRuns(h)).find((r) => r.runId === parentRun.id)!;
    assertEquals(parentRow.awaitingResume, true);
    assertEquals(parentRow.nestedWaits?.[0].status, "succeeded");
    const view = await nestedWaitView(
      { runRepo: h.runRepo, workflowRepo: h.workflowRepo },
      await only(h.runRepo, parent),
    );
    assertEquals(view.awaitingResume, true);

    await drain(h.service.resume(parent.name, parentRun.id));
    const done = await only(h.runRepo, parent);
    assertEquals(done.status, "succeeded");
    assertEquals(
      h.executor.executed.includes(`${parent.name}/after-nested`),
      true,
    );
    // No second child was ever started.
    assertEquals((await h.runRepo.findAllByWorkflowId(child.id)).length, 1);
  });
});

Deno.test("nested approval: a child an older binary saved without its back-link is still adopted by the parent", async () => {
  const child = gatedChild();
  const parent = caller("waiting-parent", child.name);
  await withHarness([parent, child], async (h) => {
    await drain(h.service.run(parent.name));
    const parentRun = await only(h.runRepo, parent);
    const childRun = await only(h.runRepo, child);
    await completed<WorkflowApproveData>(
      workflowApprove(
        createLibSwampContext(),
        createWorkflowApproveDeps(h.workflowRepo, h.runRepo, unclaimedRuns),
        { workflowIdOrName: child.name, stepName: "gate", runId: childRun.id },
      ),
    );
    await drain(h.service.resume(child.name, childRun.id));

    // An older binary keeps the fields it knows and drops parentRun when it
    // saves the child.
    const childPath = h.runRepo.getPath(
      createWorkflowId(child.id),
      createWorkflowRunId(childRun.id),
    );
    const saved = parseYaml(await Deno.readTextFile(childPath)) as Record<
      string,
      unknown
    >;
    assert(saved.parentRun !== undefined);
    delete saved.parentRun;
    await Deno.writeTextFile(childPath, stringifyYaml(saved));

    await drain(h.service.resume(parent.name, parentRun.id));
    assertEquals((await only(h.runRepo, parent)).status, "succeeded");
    assertEquals(
      h.executor.executed.includes(`${parent.name}/after-nested`),
      true,
    );
  });
});

Deno.test("nested approval: rejecting the child fails the parent's step as a rejected approval, and a plain retry is refused", async () => {
  const child = gatedChild();
  const parent = caller("waiting-parent", child.name);
  await withHarness([parent, child], async (h) => {
    await drain(h.service.run(parent.name));
    const parentRun = await only(h.runRepo, parent);
    const childRun = await only(h.runRepo, child);

    const rejected = await completed<WorkflowRejectData>(
      workflowReject(
        createLibSwampContext(),
        createWorkflowRejectDeps(
          h.workflowRepo,
          h.runRepo,
          unclaimedRuns,
          () => Promise.resolve(null),
        ),
        {
          workflowIdOrName: child.name,
          stepName: "gate",
          runId: childRun.id,
          reason: "not today",
        },
      ),
    );
    assertEquals(rejected.awaitingParent?.runId, parentRun.id);

    const events = await drain(h.service.resume(parent.name, parentRun.id));
    const failed = await only(h.runRepo, parent);
    assertEquals(failed.status, "failed");
    assertEquals(failed.failedSteps()[0].approvalRejected, true);
    // The step's failure names the child, and says which workflow it is, so
    // serve can hide it from a caller who may not read that workflow.
    const stepFailed = events.find((e) => e.kind === "step_failed");
    assert(stepFailed?.kind === "step_failed");
    assertEquals(stepFailed.nestedRun, {
      workflowId: child.id,
      workflowName: child.name,
    });

    const error = await assertRejects(
      () => drain(h.service.resume(parent.name, parentRun.id)),
      UserError,
    );
    assertStringIncludes(error.message.toLowerCase(), "reject");
  });
});

Deno.test("nested approval: cancelling the waiting parent leaves the child suspended and lists it", async () => {
  const child = gatedChild();
  const parent = caller("waiting-parent", child.name);
  await withHarness([parent, child], async (h) => {
    await drain(h.service.run(parent.name));
    const parentRun = await only(h.runRepo, parent);
    const childRun = await only(h.runRepo, child);

    const cancelled = await completed<WorkflowCancelSuspendedData>(
      workflowCancelSuspended(
        createLibSwampContext(),
        createWorkflowCancelSuspendedDeps(
          h.workflowRepo,
          h.runRepo,
          () => true,
          () => Promise.resolve(null),
        ),
        { runId: parentRun.id, reason: "operator" },
      ),
    );
    assertEquals(cancelled.detachedNestedRuns?.map((d) => d.runId), [
      childRun.id,
    ]);
    assertEquals(
      cancelled.detachedNestedRuns![0].cancelCommand,
      `swamp workflow cancel ${child.name} --run ${childRun.id}`,
    );
    assertEquals((await only(h.runRepo, child)).status, "suspended");

    const approvals = await completed<WorkflowApprovalsData>(
      workflowApprovals(
        createLibSwampContext(),
        createWorkflowApprovalsDeps(h.workflowRepo, h.runRepo),
      ),
    );
    assertEquals(approvals.approvals[0].parentWaiting, false);
  });
});

Deno.test("nested approval: a direct run of the child workflow never supersedes a child its parent waits on", async () => {
  const child = gatedChild();
  const parent = caller("waiting-parent", child.name);
  await withHarness([parent, child], async (h) => {
    await drain(h.service.run(parent.name));
    const childRun = await only(h.runRepo, child);
    const { cancelledRunIds } = await supersedeSuspendedRuns(
      child,
      {},
      {
        findSuspendedRuns: (id) => h.runRepo.findAllByWorkflowId(id),
        findEvaluatedWorkflow: () => Promise.resolve(null),
        runClaims: unclaimedRuns,
      },
      h.runRepo,
    );
    assertEquals(cancelledRunIds, []);
    assertEquals(
      (await h.runRepo.findById(child.id, childRun.id))!.status,
      "suspended",
    );
  });
});

Deno.test("nested approval: run cleanup keeps a finished child its parent waits on or that cannot be read, and collects it once the parent is gone", async () => {
  const child = gatedChild();
  const parent = caller("waiting-parent", child.name);
  await withHarness([parent, child], async (h) => {
    await drain(h.service.run(parent.name));
    const childRun = await only(h.runRepo, child);
    await completed(
      workflowApprove(
        createLibSwampContext(),
        createWorkflowApproveDeps(h.workflowRepo, h.runRepo, unclaimedRuns),
        { workflowIdOrName: child.name, stepName: "gate", runId: childRun.id },
      ),
    );
    await drain(h.service.resume(child.name, childRun.id));

    const childPath = h.runRepo.getPath(child.id, childRun.id);
    const old = new Date("2020-01-01T00:00:00Z");
    await Deno.utime(childPath, old, old);
    const future = new Date(Date.now() + 60_000);

    let result = await h.runRepo.deleteOlderThan(future, { dryRun: true });
    assertEquals(result.deletedRunIds.includes(childRun.id), false);

    // A parent that cannot be read (a transient read error) may still wait:
    // the child is kept.
    const findById = h.runRepo.findById;
    h.runRepo.findById = () => Promise.reject(new Error("EMFILE"));
    try {
      result = await h.runRepo.deleteOlderThan(future, { dryRun: true });
    } finally {
      h.runRepo.findById = findById;
    }
    assertEquals(result.deletedRunIds.includes(childRun.id), false);

    await h.runRepo.deleteAllByWorkflowId(parent.id);
    result = await h.runRepo.deleteOlderThan(future, { dryRun: true });
    assertEquals(result.deletedRunIds.includes(childRun.id), true);
  });
});

Deno.test("nested approval: two levels of nesting suspend every ancestor and resume upward", async () => {
  const child = gatedChild();
  const middle = caller("middle", child.name);
  const root = caller("root", middle.name);
  await withHarness([root, middle, child], async (h) => {
    await drain(h.service.run(root.name));
    const rootRun = await only(h.runRepo, root);
    const middleRun = await only(h.runRepo, middle);
    const childRun = await only(h.runRepo, child);
    assertEquals(
      [rootRun.status, middleRun.status, childRun.status],
      ["suspended", "suspended", "suspended"],
    );
    const back = childRun.parentRun;
    assert(back?.kind === "valid");
    assertEquals(back.ref.nestingDepth, 2);
    assertEquals(back.ref.ancestorWorkflowNames, [root.name, middle.name]);

    // The root's refusal walks down to the gate that has to act.
    const error = await assertRejects(
      () => drain(h.service.resume(root.name, rootRun.id)),
      NestedRunPendingError,
    );
    assertStringIncludes(
      error.message,
      `swamp workflow approve ${child.name} gate --run ${childRun.id}`,
    );

    await completed(
      workflowApprove(
        createLibSwampContext(),
        createWorkflowApproveDeps(h.workflowRepo, h.runRepo, unclaimedRuns),
        { workflowIdOrName: child.name, stepName: "gate", runId: childRun.id },
      ),
    );
    await drain(h.service.resume(child.name, childRun.id));
    await drain(h.service.resume(middle.name, middleRun.id));
    await drain(h.service.resume(root.name, rootRun.id));
    assertEquals((await only(h.runRepo, root)).status, "succeeded");
  });
});
