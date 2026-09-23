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

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { UserError } from "../../domain/errors.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { createWorkflowRunId } from "../../domain/workflows/workflow_id.ts";
import {
  type StepExecutor,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import { VERSION } from "./version.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-workflow-recover-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Initializes `dir` as a swamp repo and returns its repository context. */
async function initRepo(dir: string) {
  // Keep the global skill install inside `dir` — the ambient HOME is shared
  // with every other test file in the process.
  const homeDir = join(dir, "test-home");
  const service = new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  });
  await service.init(RepoPath.create(dir), { tools: [] });
  const { repoContext } = await requireInitializedRepoUnlocked({
    repoDir: dir,
    outputMode: "json",
  });
  return repoContext;
}

/** A one-step workflow; the step carries a guard when `guard` is set. */
function deployWorkflow(name: string, guard?: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            guard,
          }),
        ],
      }),
    ],
  });
}

/** An interrupted run of `workflow`'s one step, as the crash reaper leaves it. */
function interruptedRun(workflow: Workflow, startedAt: string): WorkflowRun {
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "interrupted",
    startedAt,
    completedAt: startedAt,
    jobs: [{
      jobName: "main",
      status: "unknown",
      startedAt,
      steps: [{
        stepName: "deploy",
        status: "unknown",
        startedAt,
        error: "interrupted: server_crash",
      }],
    }],
    tags: { interrupt_reason: "server_crash" },
  });
}

/** Runs `workflow recover` with `args` and returns what it wrote to stdout. */
async function recover(args: string[]): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const { workflowRecoverCommand } = await import("./workflow_recover.ts");
    const root = new Command()
      .globalOption("--json", "JSON output")
      .command("recover", workflowRecoverCommand);
    await root.parse(["recover", ...args]);
    return logs;
  } finally {
    console.log = originalLog;
  }
}

/** Parses the JSON document `workflow recover --json` wrote last. */
function lastJson(logs: string[]): Record<string, unknown> {
  return JSON.parse(logs[logs.length - 1]) as Record<string, unknown>;
}

Deno.test("workflowRecoverCommand: --assess-only --json reports the assessment and leaves the run interrupted", async () => {
  await withTempDir(async (dir) => {
    const repoContext = await initRepo(dir);
    const workflow = deployWorkflow("guarded", "${{ false }}");
    await repoContext.workflowRepo.save(workflow);
    const run = interruptedRun(workflow, "2026-09-20T10:00:00.000Z");
    await repoContext.workflowRunRepo.save(workflow.id, run);

    const assessment = lastJson(
      await recover(["guarded", "--assess-only", "--json", "--repo-dir", dir]),
    );

    assertEquals(assessment.canAutoRecover, true);
    assertEquals(assessment.guardedSteps, ["deploy"]);
    assertEquals(assessment.unguardedSteps, []);
    assertEquals(assessment.runId, run.id);
    assertEquals(assessment.fingerprintMismatch, false);
    const reloaded = await repoContext.workflowRunRepo.findById(
      workflow.id,
      createWorkflowRunId(run.id),
    );
    assertEquals(reloaded?.status, "interrupted");
  });
});

Deno.test("workflowRecoverCommand: --assess-only prints the assessment in log mode", async () => {
  await withTempDir(async (dir) => {
    const repoContext = await initRepo(dir);
    const workflow = deployWorkflow("guarded", "${{ false }}");
    await repoContext.workflowRepo.save(workflow);
    const run = interruptedRun(workflow, "2026-09-20T10:00:00.000Z");
    await repoContext.workflowRunRepo.save(workflow.id, run);

    const logs = await recover(["guarded", "--assess-only", "--repo-dir", dir]);

    assertEquals(logs, [
      `Recovery assessment for "guarded":`,
      `  Run ID: ${run.id}`,
      "  Can auto-recover: true",
      "  Guarded steps (auto-recoverable): deploy",
    ]);
  });
});

Deno.test("workflowRecoverCommand: recovers a guarded run without acknowledgement", async () => {
  await withTempDir(async (dir) => {
    const repoContext = await initRepo(dir);
    const workflow = deployWorkflow("guarded", "${{ false }}");
    await repoContext.workflowRepo.save(workflow);
    const run = interruptedRun(workflow, "2026-09-20T10:00:00.000Z");
    await repoContext.workflowRunRepo.save(workflow.id, run);

    const result = lastJson(
      await recover(["guarded", "--json", "--repo-dir", dir]),
    );

    assertEquals(result, {
      recovered: true,
      runId: run.id,
      resumeCommand: `swamp workflow resume guarded --run ${run.id}`,
    });
    const reloaded = await repoContext.workflowRunRepo.findById(
      workflow.id,
      createWorkflowRunId(run.id),
    );
    assertEquals(reloaded?.status, "suspended");
    assertEquals(reloaded?.jobs[0].steps[0].status, "pending");
  });
});

Deno.test("workflowRecoverCommand: an unguarded run needs --acknowledge-unknown", async () => {
  await withTempDir(async (dir) => {
    const repoContext = await initRepo(dir);
    const workflow = deployWorkflow("unguarded");
    await repoContext.workflowRepo.save(workflow);
    const run = interruptedRun(workflow, "2026-09-20T10:00:00.000Z");
    await repoContext.workflowRunRepo.save(workflow.id, run);
    const findRun = () =>
      repoContext.workflowRunRepo.findById(
        workflow.id,
        createWorkflowRunId(run.id),
      );

    await assertRejects(
      () => recover(["unguarded", "--json", "--repo-dir", dir]),
      UserError,
      "Use --acknowledge-unknown to accept re-execution risk.",
    );
    assertEquals((await findRun())?.status, "interrupted");

    const result = lastJson(
      await recover([
        "unguarded",
        "--acknowledge-unknown",
        "--json",
        "--repo-dir",
        dir,
      ]),
    );

    assertEquals(result.recovered, true);
    assertEquals((await findRun())?.status, "suspended");
  });
});

Deno.test("workflowRecoverCommand: resolves the workflow by ID", async () => {
  await withTempDir(async (dir) => {
    const repoContext = await initRepo(dir);
    const workflow = deployWorkflow("guarded", "${{ false }}");
    await repoContext.workflowRepo.save(workflow);
    const run = interruptedRun(workflow, "2026-09-20T10:00:00.000Z");
    await repoContext.workflowRunRepo.save(workflow.id, run);

    const assessment = lastJson(
      await recover([
        workflow.id,
        "--assess-only",
        "--json",
        "--repo-dir",
        dir,
      ]),
    );

    assertEquals(assessment.runId, run.id);
    assertEquals(assessment.workflowId, workflow.id);
  });
});

Deno.test("workflowRecoverCommand: rejects a workflow that does not exist", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);

    await assertRejects(
      () => recover(["no-such-workflow", "--json", "--repo-dir", dir]),
      UserError,
      "Workflow not found: no-such-workflow",
    );
  });
});

Deno.test("workflowRecoverCommand: --run recovers the named run and leaves the other interrupted", async () => {
  await withTempDir(async (dir) => {
    const repoContext = await initRepo(dir);
    const workflow = deployWorkflow("guarded", "${{ false }}");
    await repoContext.workflowRepo.save(workflow);
    const older = interruptedRun(workflow, "2026-09-20T10:00:00.000Z");
    const newer = interruptedRun(workflow, "2026-09-21T10:00:00.000Z");
    await repoContext.workflowRunRepo.save(workflow.id, older);
    await repoContext.workflowRunRepo.save(workflow.id, newer);

    const result = lastJson(
      await recover([
        "guarded",
        "--run",
        older.id,
        "--json",
        "--repo-dir",
        dir,
      ]),
    );

    assertEquals(result.runId, older.id);
    const statusOf = async (id: string) =>
      (await repoContext.workflowRunRepo.findById(
        workflow.id,
        createWorkflowRunId(id),
      ))?.status;
    assertEquals(await statusOf(older.id), "suspended");
    assertEquals(await statusOf(newer.id), "interrupted");
  });
});

Deno.test("workflowRecoverCommand: --run rejects a run that is not interrupted", async () => {
  await withTempDir(async (dir) => {
    const repoContext = await initRepo(dir);
    const workflow = deployWorkflow("guarded", "${{ false }}");
    await repoContext.workflowRepo.save(workflow);
    await repoContext.workflowRunRepo.save(
      workflow.id,
      interruptedRun(workflow, "2026-09-20T10:00:00.000Z"),
    );
    const succeeded = WorkflowRun.create(workflow);
    succeeded.start();
    succeeded.complete();
    await repoContext.workflowRunRepo.save(workflow.id, succeeded);

    await assertRejects(
      () =>
        recover([
          "guarded",
          "--run",
          succeeded.id,
          "--json",
          "--repo-dir",
          dir,
        ]),
      UserError,
      `Interrupted run ${succeeded.id} not found`,
    );
  });
});

/** A one-step workflow whose step input resolves `inputs.greeting`. */
function greetingWorkflow(message: string, id?: string): Workflow {
  return Workflow.create({
    id,
    name: "greeting",
    inputs: {
      properties: { greeting: { type: "string" } },
      required: ["greeting"],
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.modelMethod("test-model", "run", { message }),
          }),
        ],
      }),
    ],
  });
}

/**
 * Rewinds a completed one-step run to mid-step and interrupts it, the state
 * a crash leaves behind. `interrupt` returns early on a succeeded run.
 */
function interruptMidStep(run: WorkflowRun): WorkflowRun {
  const data = run.toData();
  const job = data.jobs[0];
  const step = job.steps[0];
  data.status = "running";
  data.completedAt = undefined;
  job.status = "running";
  job.completedAt = undefined;
  step.status = "running";
  step.completedAt = undefined;
  step.output = undefined;
  const rewound = WorkflowRun.fromData(data);
  rewound.interrupt("server_crash");
  return rewound;
}

Deno.test("workflowRecoverCommand: recovers a run of a workflow with an inputs expression, and refuses once the definition changes", async () => {
  await withTempDir(async (dir) => {
    const repoContext = await initRepo(dir);
    const workflow = greetingWorkflow("${{ inputs.greeting }}");
    await repoContext.workflowRepo.save(workflow);
    const noopExecutor: StepExecutor = {
      execute: () => Promise.resolve({ executed: true }),
    };
    // The real evaluator records the run plan, and the repo context's own
    // run repository persists it.
    const service = new WorkflowExecutionService(
      repoContext.workflowRepo,
      repoContext.workflowRunRepo,
      dir,
      noopExecutor,
      undefined,
      repoContext.catalogStore,
    );
    const runAndInterrupt = async (): Promise<WorkflowRun> => {
      const executed = await service.execute(workflow.name, {
        inputs: { greeting: "howdy" },
      });
      assertEquals(executed.status, "succeeded");
      const persisted = await repoContext.workflowRunRepo.findById(
        workflow.id,
        createWorkflowRunId(executed.id),
      );
      const interrupted = interruptMidStep(persisted!);
      await repoContext.workflowRunRepo.save(workflow.id, interrupted);
      return interrupted;
    };

    const first = await runAndInterrupt();
    // Evaluation resolved the inputs expression, so the evaluated
    // fingerprint differs from the definition's.
    assertNotEquals(
      first.runPlan?.fingerprint,
      first.runPlan?.definitionFingerprint,
    );

    const assessment = lastJson(
      await recover(["greeting", "--assess-only", "--json", "--repo-dir", dir]),
    );
    assertEquals(assessment.runId, first.id);
    assertEquals(assessment.fingerprintMismatch, false);

    const result = lastJson(
      await recover([
        "greeting",
        "--acknowledge-unknown",
        "--json",
        "--repo-dir",
        dir,
      ]),
    );
    assertEquals(result.runId, first.id);
    const recovered = await repoContext.workflowRunRepo.findById(
      workflow.id,
      createWorkflowRunId(first.id),
    );
    assertEquals(recovered?.status, "suspended");

    // A second interrupted run, then an edit to the definition. Recovery
    // moved the first run to suspended, so only the second is found.
    const second = await runAndInterrupt();
    await repoContext.workflowRepo.save(
      greetingWorkflow("${{ inputs.greeting }} again", workflow.id),
    );

    const drifted = lastJson(
      await recover(["greeting", "--assess-only", "--json", "--repo-dir", dir]),
    );
    assertEquals(drifted.runId, second.id);
    assertEquals(drifted.fingerprintMismatch, true);
    await assertRejects(
      () =>
        recover([
          "greeting",
          "--acknowledge-unknown",
          "--json",
          "--repo-dir",
          dir,
        ]),
      UserError,
      "Workflow definition changed since the run started",
    );
  });
});
