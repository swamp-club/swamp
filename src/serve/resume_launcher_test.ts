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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  autoResumeAfterApproval,
  startDetachedResume,
} from "./resume_launcher.ts";
import { type ActiveRun, ActiveRunRegistry } from "./active_run_registry.ts";
import type { ConnectionContext } from "./handlers/shared.ts";
import type { BufferTerminal } from "./run_event_buffer.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { InputsSchema } from "../domain/definitions/definition.ts";
import type { MergedServeOptions } from "./serve_config.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

/** Records every registration, so a test can see it after deregistration. */
class RecordingRegistry extends ActiveRunRegistry {
  readonly registered: ActiveRun[] = [];
  override register(run: ActiveRun): void {
    super.register(run);
    this.registered.push(run);
  }
}

function makeWorkflow(
  opts: { autoResume?: boolean; inputs?: InputsSchema } = {},
): Workflow {
  return Workflow.create({
    name: "gated",
    autoResume: opts.autoResume,
    inputs: opts.inputs,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve"),
          }),
          Step.create({
            name: "deploy",
            task: StepTask.model("deployer", "run"),
          }),
        ],
      }),
    ],
  });
}

/** A run whose only gate has been approved: suspended, awaiting resume. */
function makeApprovedRun(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const gate = job.getStep("gate")!;
  gate.start();
  gate.waitForApproval();
  run.suspend();
  gate.succeed();
  return run;
}

interface Harness {
  ctx: ConnectionContext;
  registry: RecordingRegistry;
  audit: Array<{ action: string; detail?: string }>;
  lookedUp: string[];
}

function makeHarness(
  workflow: Workflow,
  run: WorkflowRun,
  serveAutoResume = false,
): Harness {
  const registry = new RecordingRegistry();
  const audit: Array<{ action: string; detail?: string }> = [];
  const lookedUp: string[] = [];
  const ctx = {
    repoDir: "/nonexistent-swamp-repo",
    activeRunRegistry: registry,
    serveOptions: { autoResume: serveAutoResume } as MergedServeOptions,
    auditEmitter: {
      emit: (event: { action: string; detail?: string }) => {
        audit.push({ action: event.action, detail: event.detail });
      },
    } as unknown as AuditEmitter,
    // Enough to resolve the run. Anything past resolution is missing, so a
    // launched resume fails and reports through its terminal.
    repoContext: {
      workflowRepo: {
        findByName: (name: string) => {
          lookedUp.push(name);
          return Promise.resolve(name === workflow.name ? workflow : null);
        },
        findById: () => Promise.resolve(null),
      },
      workflowRunRepo: {
        findById: () => Promise.resolve(run),
        findAllByWorkflowId: () => Promise.resolve([run]),
      },
    },
  } as unknown as ConnectionContext;
  return { ctx, registry, audit, lookedUp };
}

function outcomeFor(run: WorkflowRun, allGatesDecided = true) {
  return {
    workflowName: "gated",
    runId: run.id,
    decidedBy: "user:approver",
    allGatesDecided,
  };
}

Deno.test("startDetachedResume: refuses a run that is not suspended without registering it", async () => {
  const workflow = makeWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  const { ctx, registry } = makeHarness(workflow, run);

  const result = await startDetachedResume(ctx, registry, {
    workflowIdOrName: "gated",
    runId: run.id,
    principalId: null,
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "workflow_resume_failed");
  assertEquals(registry.registered.length, 0);
});

for (const from of ["deploy", undefined]) {
  Deno.test(
    `startDetachedResume: refuses ${
      from ? "--from" : "a retry"
    } on a workflow whose structure changed, without registering it`,
    async () => {
      // The run failed at deploy; since then a step was added to its job.
      const run = WorkflowRun.create(makeWorkflow());
      run.start();
      const job = run.getJob("main")!;
      job.getStep("gate")!.succeed();
      job.getStep("deploy")!.fail("boom");
      job.fail();
      run.complete();
      const edited = Workflow.create({
        name: "gated",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "gate",
                task: StepTask.manualApproval("ok"),
              }),
              Step.create({ name: "deploy", task: StepTask.model("d", "run") }),
              Step.create({ name: "verify", task: StepTask.model("v", "run") }),
            ],
          }),
        ],
      });
      const { ctx, registry } = makeHarness(edited, run);

      const result = await startDetachedResume(ctx, registry, {
        workflowIdOrName: "gated",
        runId: run.id,
        principalId: null,
        from,
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.code, "workflow_resume_failed");
        assertStringIncludes(
          result.message,
          `Step "verify" in job "main" is not in the run. Start a new run.`,
        );
        assertEquals(result.message.length <= 200, true, result.message);
      }
      assertEquals(registry.registered.length, 0);
    },
  );
}

Deno.test("startDetachedResume: registers the resume and unwinds the registration when it fails", async () => {
  const workflow = makeWorkflow();
  const run = makeApprovedRun(workflow);
  const { ctx, registry } = makeHarness(workflow, run);
  const terminals: BufferTerminal[] = [];

  const result = await startDetachedResume(ctx, registry, {
    workflowIdOrName: "gated",
    runId: run.id,
    principalId: "user:operator",
    onTerminal: (t) => terminals.push(t),
  });

  assertEquals(result.ok, true);
  assertEquals(registry.registered.length, 1);
  assertEquals(registry.registered[0].kind, "workflow-resume");
  assertEquals(registry.registered[0].runId, run.id);
  assertEquals(registry.registered[0].principalId, "user:operator");

  await waitFor(() => terminals.length === 1, "resume terminal reported");
  assertEquals(terminals[0].kind, "error");
  assertEquals(registry.get(run.id), undefined);
});

Deno.test("startDetachedResume: refuses a run that is already registered", async () => {
  const workflow = makeWorkflow();
  const run = makeApprovedRun(workflow);
  const { ctx, registry } = makeHarness(workflow, run);
  registry.register({
    runId: run.id,
    kind: "workflow-resume",
    resourceName: "gated",
    buffer: undefined as unknown as ActiveRun["buffer"],
    controller: new AbortController(),
    startedAt: new Date(),
    completion: Promise.resolve(),
    principalId: null,
  });

  const result = await startDetachedResume(ctx, registry, {
    workflowIdOrName: "gated",
    runId: run.id,
    principalId: null,
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "already_registered");
  registry.deregister(run.id);
});

Deno.test("autoResumeAfterApproval: does nothing unless the policy and gate state allow it", async () => {
  const withInputs: InputsSchema = {
    type: "object",
    properties: { authKey: { type: "string" } },
  };
  const cases = [
    {
      name: "a gate still waits",
      workflow: makeWorkflow({ autoResume: true }),
      serve: true,
      decided: false,
    },
    {
      name: "not opted in",
      workflow: makeWorkflow(),
      serve: false,
      decided: true,
    },
    {
      name: "workflow opts out",
      workflow: makeWorkflow({ autoResume: false }),
      serve: true,
      decided: true,
    },
    {
      name: "server flag, workflow has inputs",
      workflow: makeWorkflow({ inputs: withInputs }),
      serve: true,
      decided: true,
    },
  ];
  for (const c of cases) {
    const run = makeApprovedRun(c.workflow);
    const { ctx, registry, audit } = makeHarness(c.workflow, run, c.serve);

    const launched = await autoResumeAfterApproval(
      ctx,
      outcomeFor(run, c.decided),
      "user:approver",
    );

    assertEquals(launched, false, c.name);
    assertEquals(registry.registered.length, 0, c.name);
    assertEquals(audit, [], c.name);
  }
});

Deno.test("autoResumeAfterApproval: launches with the resolved identity, charged to the approver", async () => {
  const workflow = makeWorkflow({ autoResume: true });
  const run = makeApprovedRun(workflow);
  const { ctx, registry, audit, lookedUp } = makeHarness(workflow, run);

  const launched = await autoResumeAfterApproval(
    ctx,
    outcomeFor(run),
    "user:approver",
  );

  assertEquals(launched, true);
  assertEquals(lookedUp[0], "gated");
  assertEquals(registry.registered.length, 1);
  assertEquals(registry.registered[0].runId, run.id);
  assertEquals(registry.registered[0].principalId, "user:approver");
  assertEquals(audit[0].action, "workflow.auto_resume");
});

Deno.test("autoResumeAfterApproval: the server flag covers a workflow that declares no inputs", async () => {
  const workflow = makeWorkflow();
  const run = makeApprovedRun(workflow);
  const { ctx, registry } = makeHarness(workflow, run, true);

  const launched = await autoResumeAfterApproval(
    ctx,
    outcomeFor(run),
    null,
  );

  assertEquals(launched, true);
  assertEquals(registry.registered.length, 1);
});

Deno.test("autoResumeAfterApproval: audits a resume that fails with no client listening", async () => {
  const workflow = makeWorkflow({ autoResume: true });
  const run = makeApprovedRun(workflow);
  const { ctx, audit } = makeHarness(workflow, run);

  await autoResumeAfterApproval(ctx, outcomeFor(run), "user:approver");

  await waitFor(
    () => audit.some((e) => e.action === "workflow.auto_resume_failed"),
    "auto-resume failure audited",
  );
});

Deno.test("autoResumeAfterApproval: audits a launch the registry refuses and reports no resume", async () => {
  const workflow = makeWorkflow({ autoResume: true });
  const run = makeApprovedRun(workflow);
  const { ctx, registry, audit } = makeHarness(workflow, run);
  registry.register({
    runId: run.id,
    kind: "workflow-resume",
    resourceName: "gated",
    buffer: undefined as unknown as ActiveRun["buffer"],
    controller: new AbortController(),
    startedAt: new Date(),
    completion: Promise.resolve(),
    principalId: null,
  });

  const launched = await autoResumeAfterApproval(
    ctx,
    outcomeFor(run),
    "user:approver",
  );

  assertEquals(launched, false);
  assertEquals(audit.map((e) => e.action), ["workflow.auto_resume_failed"]);
  registry.deregister(run.id);
});

/** A run whose deploy step failed after its gate was approved. */
function makeFailedRun(workflow: Workflow): WorkflowRun {
  const run = makeApprovedRun(workflow);
  const job = run.getJob("main")!;
  const deploy = job.getStep("deploy")!;
  deploy.start();
  deploy.fail("deploy failed");
  job.fail();
  run.complete();
  return run;
}

Deno.test("startDetachedResume: registers a retry of a failed run named by id", async () => {
  const workflow = makeWorkflow();
  const run = makeFailedRun(workflow);
  const { ctx, registry } = makeHarness(workflow, run);

  const result = await startDetachedResume(ctx, registry, {
    workflowIdOrName: "gated",
    runId: run.id,
    principalId: null,
  });

  assertEquals(result.ok, true);
  assertEquals(registry.registered.length, 1);
  assertEquals(registry.registered[0].runId, run.id);
  await waitFor(() => registry.get(run.id) === undefined, "resume finished");
});

Deno.test("startDetachedResume: refuses an ineligible failed run before registering it", async () => {
  const workflow = makeWorkflow();
  const run = makeFailedRun(workflow);
  run.getJob("main")!.getStep("deploy")!.resetToPending();
  const { ctx, registry } = makeHarness(workflow, run);

  const result = await startDetachedResume(ctx, registry, {
    workflowIdOrName: "gated",
    runId: run.id,
    principalId: "user:operator",
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "workflow_resume_failed");
    assertStringIncludes(result.message, `Step "deploy" in job "main"`);
  }
  assertEquals(registry.registered.length, 0);
});

Deno.test("startDetachedResume: suspendedOnly refuses a failed run before registering it", async () => {
  const workflow = makeWorkflow();
  const run = makeFailedRun(workflow);
  const { ctx, registry } = makeHarness(workflow, run);

  const result = await startDetachedResume(ctx, registry, {
    workflowIdOrName: "gated",
    runId: run.id,
    suspendedOnly: true,
    principalId: null,
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.message, "is not suspended");
  assertEquals(registry.registered.length, 0);
});

Deno.test("autoResumeAfterApproval: never retries a run that failed before launch", async () => {
  const workflow = makeWorkflow({ autoResume: true });
  const run = makeFailedRun(workflow);
  const { ctx, registry, audit } = makeHarness(workflow, run);

  const launched = await autoResumeAfterApproval(
    ctx,
    outcomeFor(run),
    "user:approver",
  );

  assertEquals(launched, false);
  assertEquals(registry.registered.length, 0);
  assertEquals(audit.map((e) => e.action), ["workflow.auto_resume_failed"]);
});
