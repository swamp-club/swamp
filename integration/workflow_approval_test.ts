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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { setColorEnabled } from "@std/fmt/colors";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  type StepExecutor,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import { consumeStream } from "../src/libswamp/stream.ts";
import {
  mapWorkflowExecutionEvent,
  type WorkflowRunEvent,
} from "../src/libswamp/workflows/run.ts";
import { createWorkflowRunRenderer } from "../src/presentation/renderers/workflow_run.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  workflowApprove,
  type WorkflowApproveEvent,
} from "../src/libswamp/workflows/approve.ts";
import {
  workflowReject,
  type WorkflowRejectEvent,
} from "../src/libswamp/workflows/reject.ts";
import {
  createWorkflowApprovalsDeps,
  workflowApprovals,
  type WorkflowApprovalsEvent,
} from "../src/libswamp/workflows/approvals.ts";
import { unclaimedRuns } from "../src/domain/workflows/run_claim.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-approval-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function initializeTestRepo(repoDir: string): Promise<void> {
  const subdirs = [
    "models",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
    "workflows",
    ".swamp/workflow-runs",
    "vaults",
    ".swamp/secrets",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(repoDir, subdir));
  }

  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(markerData as Record<string, unknown>),
  );
}

Deno.test("Workflow: manual_approval step task schema round-trips through YAML", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "approval-test",
      jobs: [
        Job.create({
          name: "gate",
          steps: [
            Step.create({
              name: "verify-deploy",
              task: StepTask.manualApproval(
                "Verify the deployment is healthy",
                300,
              ),
            }),
          ],
        }),
      ],
    });

    const repo = new YamlWorkflowRepository(repoDir);
    await repo.save(workflow);

    const loaded = await repo.findById(workflow.id);
    assertEquals(loaded?.name, "approval-test");

    const step = loaded!.jobs[0].steps[0];
    assertEquals(step.task.isManualApproval(), true);
    assertEquals(step.task.data.type, "manual_approval");
    if (step.task.data.type === "manual_approval") {
      assertEquals(step.task.data.prompt, "Verify the deployment is healthy");
      assertEquals(step.task.data.timeout, 300);
    }
  });
});

Deno.test("Workflow: manual_approval with dependencies round-trips", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "gated-deploy",
      jobs: [
        Job.create({
          name: "build-and-deploy",
          steps: [
            Step.create({
              name: "build",
              task: StepTask.model("builder", "execute"),
            }),
            Step.create({
              name: "approval-gate",
              task: StepTask.manualApproval("Verify build before deploy"),
              dependsOn: [
                {
                  step: "build",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
            Step.create({
              name: "deploy",
              task: StepTask.model("deployer", "execute"),
              dependsOn: [
                {
                  step: "approval-gate",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });

    const repo = new YamlWorkflowRepository(repoDir);
    await repo.save(workflow);

    const loaded = await repo.findById(workflow.id);
    assertEquals(loaded!.jobs[0].steps.length, 3);
    assertEquals(loaded!.jobs[0].steps[1].task.isManualApproval(), true);
    assertEquals(loaded!.jobs[0].steps[2].task.isModelMethod(), true);
  });
});

Deno.test("Workflow: suspended run persists and round-trips", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "suspend-test",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("m", "run"),
            }),
          ],
        }),
      ],
    });

    const workflowRepo = new YamlWorkflowRepository(repoDir);
    await workflowRepo.save(workflow);

    const { WorkflowRun } = await import(
      "../src/domain/workflows/workflow_run.ts"
    );
    const run = WorkflowRun.create(workflow);
    run.start();

    const job = run.getJob("job1")!;
    job.start();
    const step = job.getStep("step1")!;
    step.start();
    step.waitForApproval();
    run.suspend();

    const runRepo = new YamlWorkflowRunRepository(repoDir);
    await runRepo.save(workflow.id, run);

    const loaded = await runRepo.findById(workflow.id, run.id);
    assertEquals(loaded!.status, "suspended");
    const loadedStep = loaded!.getJob("job1")!.getStep("step1")!;
    assertEquals(loadedStep.status, "waiting_approval");
  });
});

/** No step of these workflows reaches an executor: every one is a gate. */
const NEVER_EXECUTES: StepExecutor = {
  execute: () => Promise.reject(new Error("no step should execute")),
};

/**
 * Runs `workflow` on a real repository directory and returns what
 * `workflow run` is sent: the execution events as libswamp publishes them.
 */
async function publishedRunEvents(
  repoDir: string,
  workflow: Workflow,
  inputs: Record<string, unknown>,
): Promise<WorkflowRunEvent[]> {
  await initializeTestRepo(repoDir);
  const workflowRepo = new YamlWorkflowRepository(repoDir);
  await workflowRepo.save(workflow);
  const runRepo = new YamlWorkflowRunRepository(repoDir);
  const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
  try {
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      repoDir,
      NEVER_EXECUTES,
      undefined,
      catalogStore,
    );
    const events: WorkflowRunEvent[] = [];
    for await (const event of service.run(workflow.name, { inputs })) {
      events.push(mapWorkflowExecutionEvent(event, runRepo));
    }
    return events;
  } finally {
    catalogStore.close();
  }
}

/** Renders `events` as `workflow run` prints them in the given mode. */
async function renderRun(
  mode: "log" | "json",
  workflowName: string,
  events: WorkflowRunEvent[],
): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  setColorEnabled(false);
  try {
    const renderer = createWorkflowRunRenderer(mode, { workflowName });
    await consumeStream(
      (async function* () {
        yield* events;
      })(),
      renderer.handlers(),
    );
  } finally {
    console.log = originalLog;
    setColorEnabled(true);
  }
  return lines;
}

Deno.test("Workflow: a forEach-expanded approval gate is reported as a gate by workflow run, in log and json mode (swamp-club#3217)", async () => {
  await withTempDir(async (repoDir) => {
    const workflow = Workflow.create({
      name: "foreach-input-gate",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "approve-${{ self.env }}",
              task: StepTask.manualApproval("Deploy?"),
              forEach: { item: "env", in: "${{ [inputs.env] }}" },
            }),
          ],
        }),
      ],
    });

    const events = await publishedRunEvents(repoDir, workflow, {
      env: "prod",
    });
    const suspended = events.findLast((e) => e.kind === "suspended");
    assert(suspended?.kind === "suspended");
    const runId = suspended.run.id;

    const log = (await renderRun("log", workflow.name, events)).join("\n");
    assertStringIncludes(
      log,
      "workflow foreach-input-gate — awaiting approval on step approve-prod",
    );
    assertStringIncludes(
      log,
      `swamp workflow approve foreach-input-gate approve-prod --run ${runId}`,
    );
    assertStringIncludes(
      log,
      `swamp workflow resume foreach-input-gate --run ${runId}`,
    );
    assertEquals(log.includes("waits on a nested run"), false);

    const json = await renderRun("json", workflow.name, events);
    const parsed = JSON.parse(json[json.length - 1]);
    assertEquals(parsed.approvalRequired, {
      workflowName: "foreach-input-gate",
      runId,
      stepId: "approve-prod",
      jobId: "main",
      prompt: "Deploy?",
    });
  });
});

// --- timeout of a forEach-expanded gate (swamp-club#3218) ---

for (const recorded of [true, false]) {
  const which = recorded
    ? "past its timeout"
    : "past its timeout on a run suspended before the step run held it";

  Deno.test(`Workflow: a forEach-expanded approval gate ${which} is listed as expired and refuses approve and reject (swamp-club#3218)`, async () => {
    await withTempDir(async (repoDir) => {
      const workflow = Workflow.create({
        name: "foreach-timed-gate",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "approve-${{ self.env }}",
                task: StepTask.manualApproval("Deploy?", 3600),
                forEach: { item: "env", in: "${{ [inputs.env] }}" },
              }),
            ],
          }),
        ],
      });

      const events = await publishedRunEvents(repoDir, workflow, {
        env: "prod",
      });
      const suspended = events.findLast((e) => e.kind === "suspended");
      assert(suspended?.kind === "suspended");
      const runId = suspended.run.id;

      // workflow run reports the deadline the gate was requested with.
      const json = await renderRun("json", workflow.name, events);
      assertEquals(JSON.parse(json[json.length - 1]).approvalRequired, {
        workflowName: "foreach-timed-gate",
        runId,
        stepId: "approve-prod",
        jobId: "main",
        prompt: "Deploy?",
        timeout: 3600,
      });

      // Move the gate's start two hours back, past its one-hour timeout.
      const workflowRepo = new YamlWorkflowRepository(repoDir);
      const runRepo = new YamlWorkflowRunRepository(repoDir);
      const stored = await runRepo.findById(
        workflow.id,
        createWorkflowRunId(runId),
      );
      const data = stored!.toData();
      const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();
      for (const job of data.jobs) {
        for (const step of job.steps) {
          assertEquals(step.stepName, "approve-prod");
          assertEquals(step.approvalTimeout, 3600);
          step.startedAt = twoHoursAgo;
          if (!recorded) delete step.approvalTimeout;
        }
      }
      await runRepo.save(workflow.id, WorkflowRun.fromData(data));

      const ctx = createLibSwampContext();
      const listed = (await collect<WorkflowApprovalsEvent>(
        workflowApprovals(
          ctx,
          createWorkflowApprovalsDeps(workflowRepo, runRepo),
        ),
      )).at(-1);
      assert(listed?.kind === "completed");
      assertEquals(listed.data.approvals, []);
      assertEquals(
        listed.data.expired.map((e) => [e.runId, e.stepName, e.timeoutSeconds]),
        [[runId, "approve-prod", 3600]],
      );

      const deps = { workflowRepo, runRepo, runClaims: unclaimedRuns };
      const input = {
        workflowIdOrName: workflow.name,
        stepName: "approve-prod",
        runId,
        decidedBy: "approver",
      };
      const approved = (await collect<WorkflowApproveEvent>(
        workflowApprove(ctx, deps, input),
      )).at(-1);
      assert(approved?.kind === "error");
      assertStringIncludes(
        approved.error.message,
        'Approval timed out: step "approve-prod"',
      );

      const rejected = (await collect<WorkflowRejectEvent>(
        workflowReject(ctx, {
          ...deps,
          findEvaluatedWorkflow: () => Promise.resolve(null),
        }, input),
      )).at(-1);
      assert(rejected?.kind === "error");
      assertStringIncludes(
        rejected.error.message,
        'Approval timed out: step "approve-prod"',
      );

      // Neither refusal decided the gate.
      const after = await runRepo.findById(
        workflow.id,
        createWorkflowRunId(runId),
      );
      assertEquals(
        after!.getJob("main")!.getStep("approve-prod")!.status,
        "waiting_approval",
      );
    });
  });
}
