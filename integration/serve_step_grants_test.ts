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
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import type { Principal } from "../src/domain/access/principal.ts";
import { SCHEDULER_PRINCIPAL } from "../src/domain/access/service_principal.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ScheduledExecutionService } from "../src/libswamp/workflows/scheduled_execution.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import {
  runVaultScopeContext,
  serviceRunVaultScope,
} from "../src/serve/run_vault_access_policy.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import "../src/domain/models/models.ts";
import {
  grant,
  loadRun,
  readerOf,
  ROOT,
  runnerGrants,
  saveDefinition,
  sendAs,
  stepOf,
  type VaultScopeFixture,
  withVaultScopeFixture,
} from "./serve_run_vault_scope_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

const U: Principal = { kind: "user", id: "u" };

/** the issue's grants: run on its own workflows and behaviors only */
function probeGrants(): Grant[] {
  return [
    grant("user:u", "workflow", "probe-*", ["read", "run"]),
    grant("user:u", "model", "probe-*", ["read", "run"]),
    grant("user:u", "data", "*", ["read", "write"]),
    ...runnerGrants("user:root"),
  ];
}

function steps(...list: Step[]): Job[] {
  return [Job.create({ name: "main", steps: list })];
}

function workflowOf(name: string, ...list: Step[]): Workflow {
  return Workflow.create({ name, jobs: steps(...list) });
}

function step(name: string, task: StepTask): Step {
  return Step.create({ name, task });
}

async function readers(f: VaultScopeFixture): Promise<void> {
  await readerOf(f, "other-model", "ran-other-model");
  await readerOf(f, "probe-model", "ran-probe-model");
}

function stepsRequireGrant(f: VaultScopeFixture, on = true): void {
  f.ctx.authConfig.stepsRequireExplicitGrant = on;
}

async function settled(
  f: VaultScopeFixture,
  workflow: Workflow,
): Promise<WorkflowRun> {
  let run: WorkflowRun | null = null;
  await waitFor(async () => {
    run = await f.repo.repoContext.workflowRunRepo.findLatestByWorkflowId(
      createWorkflowId(workflow.id),
    );
    return (run?.status === "succeeded" || run?.status === "failed") &&
      (f.ctx.activeRunRegistry?.size ?? 0) === 0;
  }, `a run of ${workflow.name} to finish`);
  return run!;
}

async function runAs(
  f: VaultScopeFixture,
  workflow: Workflow,
  principal: Principal,
): Promise<WorkflowRun> {
  await f.repo.repoContext.workflowRepo.save(workflow);
  await sendAs(
    f.ctx,
    "workflow.run",
    { workflowIdOrName: workflow.name },
    principal,
  );
  return await settled(f, workflow);
}

function stepDenials(audits: AuditEvent[]): AuditEvent[] {
  return audits.filter((e) =>
    e.category === "execution" && e.outcome === "denied" &&
    e.detail?.includes("step=") === true
  );
}

Deno.test({
  name:
    "serve step grants: with the setting off a workflow grant covers a step on any behavior",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      const run = await runAs(
        f,
        workflowOf(
          "probe-wf",
          step("other", StepTask.model("other-model", "read")),
        ),
        U,
      );
      assertEquals(run.status, "succeeded");
      assertEquals(f.seen, ["ran-other-model"]);
    }, { grants: probeGrants() }),
});

Deno.test({
  name:
    "serve step grants: a step on a behavior the run's principal may not run is refused before its method runs",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      stepsRequireGrant(f);
      const run = await runAs(
        f,
        workflowOf(
          "probe-wf",
          step("own", StepTask.model("probe-model", "read")),
          step("other", StepTask.model("other-model", "read")),
        ),
        U,
      );
      assertEquals(stepOf(run, "main", "own").status, "succeeded");
      const other = stepOf(run, "main", "other");
      assertEquals(other.status, "failed");
      assertStringIncludes(
        other.error ?? "",
        "Running behavior 'other-model' (method 'read') is refused for user:u: does not have 'run' on model:other-model",
      );
      assertEquals(f.seen, ["ran-probe-model"]);
      const denial = stepDenials(f.audits);
      assertEquals(denial.length, 1);
      assertEquals(denial[0].resourceName, "other-model");
      assertEquals(denial[0].principalId, "u");
    }, { grants: probeGrants() }),
});

Deno.test({
  name:
    "serve step grants: an explicit deny on the step's behavior refuses it despite a broader allow",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      stepsRequireGrant(f);
      const run = await runAs(
        f,
        workflowOf(
          "probe-wf",
          step("other", StepTask.model("other-model", "read")),
        ),
        U,
      );
      assertStringIncludes(
        stepOf(run, "main", "other").error ?? "",
        "explicitly denied 'run' on model:other-model",
      );
      assertEquals(f.seen, []);
    }, {
      grants: [
        ...probeGrants(),
        grant("user:u", "model", "*", ["read", "run"]),
        grant("user:u", "model", "other-model", ["read", "run"], "deny"),
      ],
    }),
});

Deno.test({
  name:
    "serve step grants: a nested workflow the principal may not run is refused before the child starts",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      stepsRequireGrant(f);
      // the child only calls a behavior the principal may run
      await f.repo.repoContext.workflowRepo.save(
        workflowOf(
          "other-wf",
          step("inner", StepTask.model("probe-model", "read")),
        ),
      );
      const run = await runAs(
        f,
        workflowOf(
          "probe-nested-wf",
          step("call", StepTask.workflow("other-wf")),
        ),
        U,
      );
      const call = stepOf(run, "main", "call");
      assertEquals(call.status, "failed");
      assertStringIncludes(
        call.error ?? "",
        "Running workflow 'other-wf' is refused for user:u: does not have 'run' on workflow:other-wf",
      );
      assertEquals(f.seen, []);
    }, { grants: probeGrants() }),
});

Deno.test({
  name:
    "serve step grants: a type execution step needs run on the type as well as the name",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      stepsRequireGrant(f);
      const workflow = workflowOf(
        "probe-direct-wf",
        step(
          "direct",
          StepTask.directExecution(
            f.type.normalized,
            "probe-direct",
            "read",
            { value: "ran-direct" },
          ),
        ),
      );
      const refused = await runAs(f, workflow, U);
      assertStringIncludes(
        stepOf(refused, "main", "direct").error ?? "",
        `does not have 'run' on model:${f.type.normalized}`,
      );
      assertEquals(f.seen, []);
      // refused before the resolver could save a definition under the name
      assertEquals(
        await f.repo.repoContext.definitionRepo.findByNameGlobal(
          "probe-direct",
        ),
        null,
      );
      f.setPolicy([
        ...probeGrants(),
        grant("user:u", "model", f.type.normalized, ["run"]),
      ]);
      const allowed = await runAs(f, workflow, U);
      assertEquals(allowed.status, "succeeded");
      assertEquals(f.seen, ["ran-direct"]);
    }, { grants: probeGrants() }),
});

Deno.test({
  name:
    "serve step grants: a step on a restricted type needs admin, as a direct run does",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      stepsRequireGrant(f);
      f.ctx.authConfig.restrictedModelTypes = [f.type.normalized];
      const run = await runAs(
        f,
        workflowOf(
          "probe-wf",
          step("own", StepTask.model("probe-model", "read")),
        ),
        U,
      );
      assertStringIncludes(
        stepOf(run, "main", "own").error ?? "",
        "does not have 'admin' on access:*",
      );
      assertEquals(f.seen, []);
      const [denial] = stepDenials(f.audits);
      assertEquals(
        [denial.decision?.action, denial.decision?.resourceKind],
        ["admin", "access"],
      );
    }, { grants: probeGrants() }),
});

Deno.test({
  name:
    "serve step grants: a forEach iteration resolving to a refused behavior fails alone",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      stepsRequireGrant(f);
      const run = await runAs(
        f,
        workflowOf(
          "probe-each-wf",
          Step.create({
            name: "run-${{ self.target }}",
            forEach: {
              item: "target",
              in: '${{ ["probe-model", "other-model"] }}',
            },
            task: StepTask.model("${{ self.target }}", "read"),
          }),
        ),
        U,
      );
      assertEquals(stepOf(run, "main", "run-probe-model").status, "succeeded");
      assertStringIncludes(
        stepOf(run, "main", "run-other-model").error ?? "",
        "Running behavior 'other-model'",
      );
      assertEquals(f.seen, ["ran-probe-model"]);
    }, { grants: probeGrants() }),
});

Deno.test({
  name:
    "serve step grants: a guard's model.method call on a refused behavior never runs it",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      stepsRequireGrant(f);
      const run = await runAs(
        f,
        workflowOf(
          "probe-guard-wf",
          Step.create({
            name: "guarded",
            guard: '${{ model.method("other-model", "read") }}',
            task: StepTask.model("probe-model", "read"),
          }),
        ),
        U,
      );
      assertEquals(run.status, "failed");
      assertStringIncludes(
        stepOf(run, "main", "guarded").error ?? "",
        "Running behavior 'other-model'",
      );
      assertEquals(f.seen, []);
    }, { grants: probeGrants() }),
});

Deno.test({
  name:
    "serve step grants: a method's runModel call on a refused behavior is refused at the call",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      stepsRequireGrant(f);
      const relayType = ModelType.create(
        `test/step-relay-${crypto.randomUUID()}`,
      );
      modelRegistry.register({
        type: relayType,
        version: "2026.11.27.1",
        globalArguments: z.object({}),
        methods: {
          relay: {
            description: "Runs another behavior's read",
            kind: "read",
            arguments: z.object({ target: z.string() }),
            execute: async (args, context) => {
              const result = await context.runModel!({
                definition: (args as { target: string }).target,
                method: "read",
              });
              if (!result.ok) throw new Error(result.error.message);
              return {};
            },
          },
        },
      });
      try {
        await f.repo.repoContext.definitionRepo.save(
          relayType,
          (await import("../src/domain/definitions/definition.ts")).Definition
            .create({ name: "probe-relay" }),
        );
        const run = await runAs(
          f,
          workflowOf(
            "probe-relay-wf",
            step(
              "own",
              StepTask.model("probe-relay", "relay", { target: "probe-model" }),
            ),
            step(
              "other",
              StepTask.model("probe-relay", "relay", { target: "other-model" }),
            ),
          ),
          U,
        );
        assertEquals(stepOf(run, "main", "own").status, "succeeded");
        assertStringIncludes(
          stepOf(run, "main", "other").error ?? "",
          "Running behavior 'other-model' (method 'read') is refused for user:u",
        );
        assertEquals(f.seen, ["ran-probe-model"]);
      } finally {
        modelRegistry.invalidateType(relayType);
      }
    }, { grants: probeGrants() }),
});

Deno.test({
  name:
    "serve step grants: a scheduled run is held to service:scheduler's grants on its steps",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      stepsRequireGrant(f);
      const workflow = workflowOf(
        "probe-sched-wf",
        step("own", StepTask.model("probe-model", "read")),
        step("other", StepTask.model("other-model", "read")),
      );
      await f.repo.repoContext.workflowRepo.save(workflow);
      const scheduler = new ScheduledExecutionService({
        workflowRepo: f.repo.repoContext.workflowRepo,
        repoDir: f.repo.repoDir,
        initiatedBy: "service:scheduler",
        executeWorkflow: (input, signal, onEvent) =>
          executeWorkflowWithLocks(
            f.repo.repoDir,
            f.repo.repoContext,
            f.repo.datastoreConfig,
            input,
            signal,
            onEvent,
            undefined,
            undefined,
            {
              syncGate: undefined,
              triggerSource: "schedule",
              initiatedBy: input.initiatedBy,
              vaultAccess: serviceRunVaultScope(
                runVaultScopeContext(f.ctx),
                SCHEDULER_PRINCIPAL,
              ),
            },
          ),
      });
      try {
        scheduler.enqueueForReplay({
          pendingRunId: crypto.randomUUID(),
          workflowIdOrName: workflow.name,
        });
        await waitFor(async () => {
          const run = await f.repo.repoContext.workflowRunRepo
            .findLatestByWorkflowId(createWorkflowId(workflow.id));
          return run?.status === "succeeded" || run?.status === "failed";
        }, "the scheduled run finished");
      } finally {
        await scheduler.stop();
      }
      const run = (await f.repo.repoContext.workflowRunRepo
        .findLatestByWorkflowId(createWorkflowId(workflow.id)))!;
      assertEquals(stepOf(run, "main", "own").status, "succeeded");
      assertStringIncludes(
        stepOf(run, "main", "other").error ?? "",
        "is refused for service:scheduler: explicitly denied 'run' on model:other-model",
      );
      assertEquals(f.seen, ["ran-probe-model"]);
    }, {
      grants: [
        ...probeGrants(),
        grant("service:scheduler", "model", "*", ["run"]),
        grant("service:scheduler", "model", "other-model", ["run"], "deny"),
      ],
    }),
});

Deno.test({
  name:
    "serve step grants: a run resumed after its gate is judged on the setting and grants in force at its next step",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      const workflow = Workflow.create({
        name: "probe-gated-wf",
        autoResume: true,
        jobs: steps(
          Step.create({ name: "gate", task: StepTask.manualApproval("ok?") }),
          Step.create({
            name: "other",
            task: StepTask.model("other-model", "read"),
            dependsOn: [{
              step: "gate",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ),
      });
      await f.repo.repoContext.workflowRepo.save(workflow);
      await sendAs(
        f.ctx,
        "workflow.run",
        { workflowIdOrName: workflow.name },
        U,
      );
      const suspended = await f.repo.repoContext.workflowRunRepo
        .findLatestByWorkflowId(createWorkflowId(workflow.id));
      assertEquals(suspended?.status, "suspended");
      // turned on while the run waits, as a reload would
      stepsRequireGrant(f);
      await sendAs(f.ctx, "workflow.approve", {
        workflowIdOrName: workflow.name,
        runId: suspended!.id,
        stepName: "gate",
      }, ROOT);
      let run: WorkflowRun | null = null;
      await waitFor(async () => {
        run = await loadRun(f, workflow, suspended!.id);
        return run?.status === "succeeded" || run?.status === "failed";
      }, "the resumed run finished");
      assert(run);
      assertStringIncludes(
        stepOf(run, "main", "other").error ?? "",
        "is refused for user:u: does not have 'run' on model:other-model",
      );
      assertEquals(f.seen, []);
      // one event, under the run's principal, not the resumer's
      assertEquals(
        stepDenials(f.audits).map((e) => e.principalId),
        ["u"],
      );
    }, {
      grants: [
        ...probeGrants(),
        grant("user:u", "workflow", "probe-*", ["approve"]),
      ],
      ctx: { detached: true },
    }),
});

Deno.test({
  name:
    "serve step grants: the setting applies to a behavior saved under a name the grant selects",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      stepsRequireGrant(f);
      const saved = await saveDefinition(f, "probe-by-id", {
        methods: { read: { arguments: { value: "ran-by-id" } } },
      });
      // named by id, judged by its name
      const run = await runAs(
        f,
        workflowOf(
          "probe-id-wf",
          step("own", StepTask.model(saved.id, "read")),
        ),
        U,
      );
      assertEquals(run.status, "succeeded");
      assertEquals(f.seen, ["ran-by-id"]);
    }, { grants: probeGrants() }),
});

Deno.test({
  name:
    "serve step grants: a step refused on a resume by another principal writes one audit event, under the run's principal",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await readers(f);
      const workflow = Workflow.create({
        name: "probe-resumed-wf",
        jobs: steps(
          Step.create({ name: "gate", task: StepTask.manualApproval("ok?") }),
          Step.create({
            name: "other",
            task: StepTask.model("other-model", "read"),
            dependsOn: [{
              step: "gate",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ),
      });
      await f.repo.repoContext.workflowRepo.save(workflow);
      await sendAs(
        f.ctx,
        "workflow.run",
        { workflowIdOrName: workflow.name },
        U,
      );
      const suspended = await f.repo.repoContext.workflowRunRepo
        .findLatestByWorkflowId(createWorkflowId(workflow.id));
      assertEquals(suspended?.status, "suspended");
      stepsRequireGrant(f);
      await sendAs(f.ctx, "workflow.approve", {
        workflowIdOrName: workflow.name,
        runId: suspended!.id,
        stepName: "gate",
      }, ROOT);
      await sendAs(f.ctx, "workflow.resume", {
        workflowIdOrName: workflow.name,
        runId: suspended!.id,
      }, ROOT);
      let run: WorkflowRun | null = null;
      await waitFor(async () => {
        run = await loadRun(f, workflow, suspended!.id);
        return run?.status === "succeeded" || run?.status === "failed";
      }, "the resumed run finished");
      assert(run);
      assertStringIncludes(
        stepOf(run, "main", "other").error ?? "",
        "is refused for user:u",
      );
      assertEquals(
        stepDenials(f.audits).map((e) => e.principalId),
        ["u"],
      );
    }, {
      grants: [
        ...probeGrants(),
        grant("user:u", "workflow", "probe-*", ["approve"]),
      ],
      ctx: { detached: true },
    }),
});
