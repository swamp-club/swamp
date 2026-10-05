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

// swamp-club#2895: cancelling or superseding a suspended run settles its
// unfinished jobs and steps in the stored record, as a live abort does. Runs
// are driven to suspension by the real execution service on a temp repo whose
// datastore lives outside `.swamp/`, so the evaluated snapshot a cancel
// settles against is read from where the run wrote it.

import { assertEquals } from "@std/assert";
import { z } from "zod";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import type { EvaluatedWorkflowLookup } from "../src/domain/workflows/abort_settlement.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { SWAMP_SUBDIRS } from "../src/infrastructure/persistence/paths.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  cancelLocalRun,
  findAllActiveRuns,
  resolveLocalCancelTarget,
} from "../src/cli/commands/workflow_cancel.ts";
import { supersedeSuspendedRuns } from "../src/libswamp/mod.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import type { RunTrackerRepository } from "../src/domain/models/run_tracker_repository.ts";
import type { MethodRunOutputs } from "../src/domain/workflows/orphaned_run_reaper.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { unclaimedRuns } from "../src/domain/workflows/run_claim.ts";

await initializeLogging({});

/** Cancel deps for runs with no tracker rows or method-run records. */
const untracked = {
  runTracker: {
    findAllRunning: () => [],
  } as unknown as RunTrackerRepository,
  outputRepo: {
    findByIds: () => Promise.resolve(new Map()),
    save: () => Promise.reject(new Error("unexpected output save")),
  } as MethodRunOutputs,
};

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

interface Fixture {
  dir: string;
  config: DatastoreConfig;
  repo: RepositoryContext;
  /** Reads snapshots from the datastore path the run wrote them to. */
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
  executions: string[];
}

async function removeDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-2895-repo-" });
  const datastoreDir = await Deno.makeTempDir({ prefix: "swamp-2895-ds-" });
  const config: DatastoreConfig = { type: "filesystem", path: datastoreDir };
  const resolver = new DefaultDatastorePathResolver(dir, config);
  const repo = createRepositoryContext({
    repoDir: dir,
    datastoreResolver: resolver,
  });
  const type = ModelType.create(`test/settle-${crypto.randomUUID()}`);
  const executions: string[] = [];
  modelRegistry.register({
    type,
    version: "2026.10.01.1",
    methods: {
      run: {
        description: "Record that the step ran",
        arguments: z.object({ label: z.string() }),
        execute: (args) => {
          executions.push((args as { label: string }).label);
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  await repo.definitionRepo.save(type, Definition.create({ name: "worker" }));
  const evaluatedRepo = new YamlEvaluatedWorkflowRepository(
    dir,
    resolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
  );
  try {
    await fn({
      dir,
      config,
      repo,
      findEvaluatedWorkflow: (runId) => evaluatedRepo.findByRunId(runId),
      executions,
    });
  } finally {
    repo.catalogStore.close();
    await removeDir(dir);
    await removeDir(datastoreDir);
  }
}

function gate(name: string): Step {
  return Step.create({ name, task: StepTask.manualApproval(`${name}?`) });
}

function work(name: string, after?: string): Step {
  return Step.create({
    name,
    task: StepTask.model("worker", "run", { label: name }),
    dependsOn: after
      ? [{ step: after, condition: TriggerCondition.succeeded() }]
      : [],
  });
}

/** The issue's workflow: two gated parallel jobs and an always-teardown. */
function issueWorkflow(): Workflow {
  return Workflow.create({
    name: `e2e-wf-${crypto.randomUUID()}`,
    jobs: [
      Job.create({
        name: "a-side",
        steps: [gate("gate2"), work("s", "gate2")],
      }),
      Job.create({ name: "main", steps: [gate("gate"), work("post", "gate")] }),
      Job.create({
        name: "teardown",
        steps: [work("t")],
        dependsOn: [{ job: "main", condition: TriggerCondition.always() }],
      }),
    ],
  });
}

async function suspend(
  { dir, config, repo }: Fixture,
  workflow: Workflow,
): Promise<WorkflowRun> {
  await repo.workflowRepo.save(workflow);
  const deps = await createWorkflowRunDeps(dir, repo, config);
  const service = deps.createExecutionService(
    repo.workflowRepo,
    repo.workflowRunRepo,
    dir,
    repo.catalogStore,
  );
  const run = await service.execute(workflow.name);
  assertEquals(run.status, "suspended", JSON.stringify(run.toData()));
  return run;
}

async function reload(
  { repo }: Fixture,
  workflow: Workflow,
  run: WorkflowRun,
): Promise<WorkflowRun> {
  return (await repo.workflowRunRepo.findById(workflow.id, run.id))!;
}

function statuses(run: WorkflowRun): Record<string, string> {
  const result: Record<string, string> = {};
  for (const job of run.jobs) {
    result[job.jobName] = job.status;
    for (const step of job.steps) {
      result[`${job.jobName}/${step.stepName}`] = step.status;
    }
  }
  return result;
}

Deno.test("workflow cancel settles a suspended run's jobs and steps in its record", async () => {
  await withFixture(async (fixture) => {
    const workflow = issueWorkflow();
    const suspended = await suspend(fixture, workflow);
    const approved = suspended.getJob("main")!.getStep("gate")!;
    approved.recordApprovalDecision({
      approved: true,
      decidedBy: "user:test",
      decidedAt: new Date().toISOString(),
    });
    approved.succeed();
    await fixture.repo.workflowRunRepo.save(workflow.id, suspended);

    const killed: number[] = [];
    await cancelLocalRun(suspended, workflow, "Cancelled by user", {
      runRepo: fixture.repo.workflowRunRepo,
      findEvaluatedWorkflow: fixture.findEvaluatedWorkflow,
      runClaims: unclaimedRuns,
      ...untracked,
      killProcess: (pid) => {
        killed.push(pid);
        return Promise.resolve(true);
      },
    });

    const stored = await reload(fixture, workflow, suspended);
    assertEquals(stored.status, "cancelled");
    assertEquals(stored.tags["cancel_reason"], "Cancelled by user");
    assertEquals(statuses(stored), {
      "a-side": "failed",
      "a-side/gate2": "failed",
      "a-side/s": "skipped",
      "main": "failed",
      "main/gate": "succeeded",
      "main/post": "failed",
      "teardown": "failed",
      "teardown/t": "failed",
    });
    for (const ref of ["a-side/gate2", "a-side/s", "main/post", "teardown/t"]) {
      const [job, step] = ref.split("/");
      assertEquals(stored.getJob(job)!.getStep(step)!.settledByAbort, true);
    }
    // This process owns the run, so nothing was killed; nothing ran.
    assertEquals(killed, []);
    assertEquals(fixture.executions, []);
  });
});

// swamp-club#2920: the run outlives its workflow file. Cancel finds it in the
// run store and settles it against the snapshot the run saved.
Deno.test("workflow cancel finds and settles a suspended run whose workflow file was deleted", async () => {
  await withFixture(async (fixture) => {
    const workflow = issueWorkflow();
    const suspended = await suspend(fixture, workflow);
    const { workflowRepo, workflowRunRepo: runRepo } = fixture.repo;
    await Deno.remove(workflowRepo.getPath(workflow.id));
    assertEquals(await workflowRepo.findByName(workflow.name), null);
    const lookup = { workflowRepo, runRepo };

    for (
      const input of [
        { workflowIdOrName: workflow.name },
        { workflowIdOrName: workflow.id },
        { workflowIdOrName: workflow.name, runId: suspended.id },
        { runId: suspended.id },
      ]
    ) {
      const found = await resolveLocalCancelTarget(lookup, input);
      assertEquals(found.run.id, suspended.id, JSON.stringify(input));
      assertEquals(found.workflow, undefined);
    }
    const active = await findAllActiveRuns(lookup);
    assertEquals(
      active.map(({ run, workflow }) => [run.id, workflow]),
      [[suspended.id, undefined]],
    );

    const target = active[0];
    const cancelled = await cancelLocalRun(
      target.run,
      target.workflow,
      "Cancelled by user",
      {
        runRepo,
        findEvaluatedWorkflow: fixture.findEvaluatedWorkflow,
        runClaims: unclaimedRuns,
        ...untracked,
      },
    );

    const stored = await reload(fixture, workflow, suspended);
    assertEquals(cancelled?.status, "cancelled");
    assertEquals(stored.status, "cancelled");
    assertEquals(stored.tags["cancel_reason"], "Cancelled by user");
    // The snapshot's dependsOn still decides which steps are skipped.
    assertEquals(statuses(stored), {
      "a-side": "failed",
      "a-side/gate2": "failed",
      "a-side/s": "skipped",
      "main": "failed",
      "main/gate": "failed",
      "main/post": "skipped",
      "teardown": "failed",
      "teardown/t": "failed",
    });
    assertEquals(await findAllActiveRuns(lookup), []);
    assertEquals(fixture.executions, []);
  });
});

Deno.test("superseding a suspended run settles its jobs and steps in its record", async () => {
  await withFixture(async (fixture) => {
    const workflow = issueWorkflow();
    const suspended = await suspend(fixture, workflow);
    const runRepo = fixture.repo.workflowRunRepo;

    const { cancelledRunIds } = await supersedeSuspendedRuns(
      workflow,
      suspended.inputs,
      {
        findSuspendedRuns: async (workflowId) =>
          (await runRepo.findAllByWorkflowId(workflowId))
            .filter((run) => run.status === "suspended"),
        findEvaluatedWorkflow: fixture.findEvaluatedWorkflow,
        runClaims: unclaimedRuns,
      },
      runRepo,
    );

    assertEquals(cancelledRunIds, [suspended.id]);
    const stored = await reload(fixture, workflow, suspended);
    assertEquals(
      stored.tags["cancel_reason"],
      "Superseded by new run with matching inputs",
    );
    assertEquals(statuses(stored), {
      "a-side": "failed",
      "a-side/gate2": "failed",
      "a-side/s": "skipped",
      "main": "failed",
      "main/gate": "failed",
      "main/post": "skipped",
      "teardown": "failed",
      "teardown/t": "failed",
    });
  });
});

Deno.test("workflow cancel settles an evaluated job name through the run's snapshot", async () => {
  await withFixture(async (fixture) => {
    // The job name is an expression: the run's records and its evaluated
    // snapshot carry "deploy-prod", the repository definition the raw text.
    const deployName = '${{ "deploy-" + "prod" }}';
    const workflow = Workflow.create({
      name: `named-wf-${crypto.randomUUID()}`,
      jobs: [
        Job.create({ name: deployName, steps: [gate("gate")] }),
        Job.create({
          name: "report",
          steps: [work("r")],
          dependsOn: [{
            job: deployName,
            condition: TriggerCondition.failed(),
          }],
        }),
      ],
    });
    const suspended = await suspend(fixture, workflow);
    assertEquals(suspended.getJob("deploy-prod")?.status, "running");

    await cancelLocalRun(suspended, workflow, "Cancelled by user", {
      runRepo: fixture.repo.workflowRunRepo,
      findEvaluatedWorkflow: fixture.findEvaluatedWorkflow,
      runClaims: unclaimedRuns,
      ...untracked,
      killProcess: () => Promise.resolve(true),
    });

    // With the snapshot, report's failed condition on deploy-prod holds, so
    // report is settled as the live abort would settle it, not skipped.
    const stored = await reload(fixture, workflow, suspended);
    assertEquals(statuses(stored), {
      "deploy-prod": "failed",
      "deploy-prod/gate": "failed",
      "report": "failed",
      "report/r": "failed",
    });
  });
});
