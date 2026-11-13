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
import { join } from "@std/path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { continueInterruptedRuns } from "../src/serve/interrupted_run_continuation.ts";
import { continueSettledRun } from "../src/serve/resume_launcher.ts";
import { MAX_CONSECUTIVE_AUTO_CONTINUATIONS } from "../src/domain/workflows/auto_continuation.ts";
import {
  claimsFor,
  InMemoryContinuationClaimStore,
} from "../src/domain/workflows/continuation_claim_test_helpers.ts";
import { serveHolder } from "../src/domain/workflows/continuation_claim.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { ServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const modeNone: ServeAuthConfig = {
  mode: "none",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
  restrictedModelTypes: [],
  restrictedCommands: [],
  approveRequiresExplicitGrant: false,
  signalRequiresExplicitGrant: false,
  tagRequiresExplicitGrant: false,
};

type Cut = "boundary" | "mid-step";

interface Shape {
  name: string;
  guard?: string;
  autoContinue?: boolean;
}

function shellStep(
  name: string,
  counter: string,
  guard?: string,
  after?: string,
): Step {
  return Step.create({
    name,
    guard,
    task: StepTask.directExecution(
      "command/shell",
      `${name}-shell`,
      "execute",
      { run: `echo ${name} >> ${counter}` },
    ),
    dependsOn: after === undefined
      ? []
      : [{ step: after, condition: TriggerCondition.succeeded() }],
  });
}

function twoStepWorkflow(shape: Shape, counter: string): Workflow {
  const first = shellStep("first", counter);
  const second = shellStep("second", counter, shape.guard, "first");
  return Workflow.create({
    name: shape.name,
    autoContinue: shape.autoContinue,
    jobs: [Job.create({ name: "main", steps: [first, second] })],
  });
}

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-auto-continue-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

interface Serve {
  ctx: ConnectionContext;
  registry: ActiveRunRegistry;
  audit: Array<{ action: string; detail?: string }>;
}

async function serveOver(
  repoDir: string,
  holder: string,
  claims?: InMemoryContinuationClaimStore,
): Promise<Serve> {
  const { repoDir: resolved, repoContext, datastoreConfig } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
  if (claims) {
    repoContext.continuationClaims = claimsFor(claims, holder);
  }
  const registry = new ActiveRunRegistry();
  const audit: Serve["audit"] = [];
  const ctx = {
    repoDir: resolved,
    repoContext,
    datastoreConfig,
    authConfig: modeNone,
    activeRunRegistry: registry,
    instanceId: holder,
    serveOptions: { autoResume: false } as MergedServeOptions,
    auditEmitter: {
      emit: (event: { action: string; detail?: string }) => {
        audit.push({ action: event.action, detail: event.detail });
      },
    } as unknown as AuditEmitter,
  } as ConnectionContext;
  return { ctx, registry, audit };
}

/**
 * runs the workflow to the end, then rewrites the record as a serve that died
 * at `cut` would have left it, stamped as serve stamps its own interruptions
 */
async function interruptedRun(
  repoDir: string,
  workflow: Workflow,
  cut: Cut,
  options: { stamp?: boolean; triggerSource?: string } = {},
): Promise<string> {
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
  let runId: string | undefined;
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflow.name, inputs: {} },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "started") runId = event.runId;
    },
    syncService,
    undefined,
    { syncGate: undefined },
  );
  if (!runId) throw new Error("no run id observed");
  const repo = repoContext.workflowRunRepo;
  const workflowId = createWorkflowId(workflow.id);
  const finished = await repo.findById(workflowId, createWorkflowRunId(runId));
  const data = finished!.toData();
  data.status = "running";
  data.completedAt = undefined;
  data.instanceId = "serve-gone";
  if (options.triggerSource) data.triggerSource = options.triggerSource;
  const job = data.jobs[0];
  job.status = "running";
  job.completedAt = undefined;
  const second = job.steps.find((s) => s.stepName === "second")!;
  second.status = cut === "mid-step" ? "running" : "pending";
  second.completedAt = undefined;
  if (cut === "boundary") second.startedAt = undefined;
  const run = WorkflowRun.fromData(data);
  run.interrupt("server_crash");
  if (options.stamp !== false) run.markContinuable(new Date());
  await repo.save(workflowId, run);
  return runId;
}

async function storedRun(serve: Serve, workflow: Workflow, runId: string) {
  return await serve.ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflow.id),
    createWorkflowRunId(runId),
  );
}

async function ranSteps(counter: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(counter)).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function finished(serve: Serve, runId: string): Promise<void> {
  await waitFor(
    () => serve.registry.get(runId) === undefined,
    "continued run deregistered",
  );
}

const TEST = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  ...TEST,
  name:
    "auto-continue: a run stopped at a step boundary continues under the same id without re-running finished steps",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = twoStepWorkflow({ name: "boundary" }, counter);
      const runId = await interruptedRun(repoDir, workflow, "boundary");
      await Deno.writeTextFile(counter, "");
      const serve = await serveOver(repoDir, serveHolder("a"));

      const result = await continueInterruptedRuns(serve.ctx, "boot");
      assertEquals(result.continued, [runId]);
      await finished(serve, runId);

      const run = await storedRun(serve, workflow, runId);
      assertEquals(run?.status, "succeeded");
      assertEquals(await ranSteps(counter), ["second"]);
      assertEquals(run?.autoContinuation?.count, 1);
      assertEquals(run?.autoContinuation?.interruptReason, "server_crash");
      assertEquals(serve.audit.map((a) => a.action), [
        "workflow.auto_continue",
      ]);
      assertStringIncludes(serve.audit[0].detail ?? "", "cause=boot");
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: a guarded step cut off is continued, and its guard decides whether it runs again",
  fn: () =>
    withRepo(async (repoDir) => {
      for (
        const [guard, expected] of [
          ["${{ true }}", "skipped"],
          ["${{ false }}", "succeeded"],
        ] as const
      ) {
        const counter = join(repoDir, `ran-${expected}.txt`);
        const workflow = twoStepWorkflow(
          { name: `guarded-${expected}`, guard },
          counter,
        );
        const runId = await interruptedRun(repoDir, workflow, "mid-step");
        await Deno.writeTextFile(counter, "");
        const serve = await serveOver(repoDir, serveHolder("a"));

        const result = await continueInterruptedRuns(serve.ctx, "boot", {
          runIds: new Set([runId]),
        });
        assertEquals(result.continued, [runId]);
        await finished(serve, runId);

        const run = await storedRun(serve, workflow, runId);
        assertEquals(run?.status, "succeeded");
        assertEquals(run?.getJob("main")?.getStep("second")?.status, expected);
        assertEquals(
          await ranSteps(counter),
          expected === "succeeded" ? ["second"] : [],
        );
      }
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: an unguarded step cut off stays interrupted, and the run, log and audit name it once",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = twoStepWorkflow({ name: "unguarded" }, counter);
      const runId = await interruptedRun(repoDir, workflow, "mid-step");
      await Deno.writeTextFile(counter, "");
      const serve = await serveOver(repoDir, serveHolder("a"));

      const first = await continueInterruptedRuns(serve.ctx, "boot");
      assertEquals(first.continued, []);
      assertEquals(first.refused.map((r) => [r.runId, r.reason]), [
        [runId, "unguarded_step"],
      ]);
      assertStringIncludes(first.refused[0].message, "second");
      const again = await continueInterruptedRuns(serve.ctx, "reconciliation");
      assertEquals(again.refused, []);

      const run = await storedRun(serve, workflow, runId);
      assertEquals(run?.status, "interrupted");
      assertEquals(run?.autoContinuation?.refused?.reason, "unguarded_step");
      assertEquals(run?.autoContinuation?.refused?.steps, ["second"]);
      assertEquals(await ranSteps(counter), []);
      assertEquals(serve.audit.map((a) => a.action), [
        "workflow.auto_continue_refused",
      ]);
      assertStringIncludes(serve.audit[0].detail ?? "", "step=second");
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: an opted-out workflow and a changed definition are refused",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const optedOut = twoStepWorkflow(
        { name: "opted-out", autoContinue: false },
        counter,
      );
      const optedOutRun = await interruptedRun(repoDir, optedOut, "boundary");
      const changed = twoStepWorkflow({ name: "changed" }, counter);
      const changedRun = await interruptedRun(repoDir, changed, "boundary");
      const edited = Workflow.fromData({
        ...changed.toData(),
        jobs: [{
          ...changed.toData().jobs[0],
          steps: [
            ...changed.toData().jobs[0].steps,
            shellStep("third", counter).toData(),
          ],
        }],
      });
      await new YamlWorkflowRepository(repoDir).save(edited);
      await Deno.writeTextFile(counter, "");
      const serve = await serveOver(repoDir, serveHolder("a"));

      const result = await continueInterruptedRuns(serve.ctx, "boot");
      assertEquals(result.continued, []);
      const reasons = Object.fromEntries(
        result.refused.map((r) => [r.runId, r.reason]),
      );
      assertEquals(reasons[optedOutRun], "opted_out");
      assertEquals(reasons[changedRun], "definition_changed");
      assertEquals(await ranSteps(counter), []);
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: a run serve never stamped, or one not started through serve, is left alone",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = twoStepWorkflow({ name: "unstamped" }, counter);
      const runId = await interruptedRun(repoDir, workflow, "boundary", {
        stamp: false,
      });
      const serve = await serveOver(repoDir, serveHolder("a"));

      const result = await continueInterruptedRuns(serve.ctx, "boot");
      assertEquals(result, { continued: [], refused: [] });
      assertEquals(
        (await storedRun(serve, workflow, runId))?.status,
        "interrupted",
      );
      assertEquals(serve.audit, []);
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: a scheduled run is continued like an API run and handed to the scheduler until it ends",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = twoStepWorkflow({ name: "nightly" }, counter);
      const runId = await interruptedRun(repoDir, workflow, "boundary", {
        triggerSource: "schedule",
      });
      const serve = await serveOver(repoDir, serveHolder("a"));
      const adopted: Array<[string, string]> = [];
      let completion: Promise<void> | undefined;

      await continueInterruptedRuns(serve.ctx, "boot", {
        onScheduledRunContinued: (workflowId, id, done) => {
          adopted.push([workflowId, id]);
          completion = done;
        },
      });
      assertEquals(adopted, [[workflow.id, runId]]);
      await completion;
      assertEquals(
        (await storedRun(serve, workflow, runId))?.status,
        "succeeded",
      );
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: two serve processes finding the same interrupted run continue it exactly once",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = twoStepWorkflow({ name: "raced" }, counter);
      const runId = await interruptedRun(repoDir, workflow, "boundary");
      await Deno.writeTextFile(counter, "");
      const claims = new InMemoryContinuationClaimStore();
      const a = await serveOver(repoDir, serveHolder("a"), claims);
      const b = await serveOver(repoDir, serveHolder("b"), claims);
      // each knows the other is alive, as a rolling restart's two processes do
      a.ctx.repoContext.continuationClaims = claimsFor(
        claims,
        serveHolder("a"),
        { [serveHolder("b")]: "alive" },
      );
      b.ctx.repoContext.continuationClaims = claimsFor(
        claims,
        serveHolder("b"),
        { [serveHolder("a")]: "alive" },
      );

      const [ra, rb] = await Promise.all([
        continueInterruptedRuns(a.ctx, "boot"),
        continueInterruptedRuns(b.ctx, "lead"),
      ]);
      assertEquals(ra.continued.length + rb.continued.length, 1);
      await finished(a, runId);
      await finished(b, runId);

      assertEquals(await ranSteps(counter), ["second"]);
      const run = await storedRun(a, workflow, runId);
      assertEquals(run?.status, "succeeded");
      assertEquals(run?.autoContinuation?.count, 1);
      const continuedAudits = [...a.audit, ...b.audit].filter((e) =>
        e.action === "workflow.auto_continue"
      );
      assertEquals(continuedAudits.length, 1);
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: a run serve recovered and died before resuming is finished by the continuation sweep",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = twoStepWorkflow({ name: "half-done" }, counter);
      const runId = await interruptedRun(repoDir, workflow, "boundary");
      await Deno.writeTextFile(counter, "");
      const serve = await serveOver(repoDir, serveHolder("a"));
      const repo = serve.ctx.repoContext.workflowRunRepo;
      const run = (await storedRun(serve, workflow, runId))!;
      run.resetUnknownStepsForRecovery({
        holder: serveHolder("gone"),
        at: new Date(),
      });
      await repo.save(createWorkflowId(workflow.id), run);

      const launched = await continueSettledRun(
        serve.ctx,
        { workflowId: workflow.id, runId },
        { kind: "sweep", principalId: null, takeover: true },
      );
      assert(launched, "the sweep left the run suspended");
      await finished(serve, runId);
      assertEquals(
        (await storedRun(serve, workflow, runId))?.status,
        "succeeded",
      );
      assertEquals(await ranSteps(counter), ["second"]);
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: a run cut off at the same step every time is refused once the cap is reached",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = twoStepWorkflow(
        { name: "crash-loop", guard: "${{ false }}" },
        counter,
      );
      const runId = await interruptedRun(repoDir, workflow, "mid-step");
      const serve = await serveOver(repoDir, serveHolder("a"));
      const repo = serve.ctx.repoContext.workflowRunRepo;
      const run = (await storedRun(serve, workflow, runId))!;
      for (let i = 0; i < MAX_CONSECUTIVE_AUTO_CONTINUATIONS; i++) {
        run.resetUnknownStepsForRecovery({
          holder: serveHolder("a"),
          at: new Date(),
        });
        run.resumeFromSuspended({ pid: 1, instanceId: "serve-gone" });
        run.getJob("main")!.start();
        run.getJob("main")!.getStep("second")!.start();
        run.interrupt("server_crash");
        run.markContinuable(new Date());
      }
      await repo.save(createWorkflowId(workflow.id), run);

      const result = await continueInterruptedRuns(serve.ctx, "boot");
      assertEquals(result.continued, []);
      assertEquals(result.refused[0]?.reason, "continued_too_often");
      assertEquals(
        (await storedRun(serve, workflow, runId))?.status,
        "interrupted",
      );
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: a refusal is not written over a copy the datastore has moved past",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = twoStepWorkflow({ name: "operator-first" }, counter);
      const runId = await interruptedRun(repoDir, workflow, "mid-step");
      const serve = await serveOver(repoDir, serveHolder("a"));
      // an operator's recover landed in the datastore after this copy was read
      serve.ctx.repoContext.runRecordCurrency = () => Promise.resolve(false);

      const result = await continueInterruptedRuns(serve.ctx, "boot");
      assertEquals(result, { continued: [], refused: [] });
      const run = await storedRun(serve, workflow, runId);
      assertEquals(run?.autoContinuation, undefined);
      assertEquals(serve.audit, []);
    }),
});

Deno.test({
  ...TEST,
  name:
    "auto-continue: a continuation recover refuses before its own claim leaves no claim behind",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = twoStepWorkflow({ name: "edited-mid-launch" }, counter);
      const runId = await interruptedRun(repoDir, workflow, "boundary");
      const claims = new InMemoryContinuationClaimStore();
      const serve = await serveOver(repoDir, serveHolder("a"), claims);
      // the definition changes after the verdict and the launch resolved it
      const edited = Workflow.fromData({
        ...workflow.toData(),
        jobs: [{
          ...workflow.toData().jobs[0],
          steps: [
            ...workflow.toData().jobs[0].steps,
            shellStep("third", counter).toData(),
          ],
        }],
      });
      const repo = serve.ctx.repoContext.workflowRepo;
      const findById = repo.findById.bind(repo);
      let lookups = 0;
      repo.findById = (id) =>
        ++lookups <= 2 ? findById(id) : Promise.resolve(edited);
      const findByName = repo.findByName.bind(repo);
      repo.findByName = (name) =>
        lookups >= 2 ? Promise.resolve(null) : findByName(name);

      const result = await continueInterruptedRuns(serve.ctx, "boot");
      assertEquals(result.continued, [runId]);
      await finished(serve, runId);
      await waitFor(
        () =>
          serve.audit.some((a) => a.action === "workflow.auto_continue_failed"),
        "the failed continuation audited",
      );

      assertEquals(claims.claims, []);
      assertEquals(
        (await storedRun(serve, workflow, runId))?.status,
        "interrupted",
      );
    }),
});
