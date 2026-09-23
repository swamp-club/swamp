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
import {
  assessRecoveryForRun,
  findInterruptedRun,
} from "./recovery_assessment.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import { computeWorkflowFingerprint } from "./workflow_fingerprint.ts";
import type { WorkflowRunRepository } from "./repositories.ts";
import type { WorkflowId } from "./workflow_id.ts";

function createWorkflow(opts?: { guard?: string }): Workflow {
  return Workflow.create({
    name: "test-wf",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("test-model", "run"),
            guard: opts?.guard,
          }),
          Step.create({
            name: "step2",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

function createInterruptedRun(wf: Workflow): WorkflowRun {
  const run = WorkflowRun.create(wf);
  run.start();
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  run.interrupt("server_crash");
  return run;
}

Deno.test("assessRecoveryForRun: unguarded unknown steps block auto-recovery", async () => {
  const wf = createWorkflow();
  const run = createInterruptedRun(wf);

  const result = await assessRecoveryForRun(wf, run);

  assertEquals(result.canAutoRecover, false);
  assertEquals(result.unguardedSteps, ["step1"]);
  assertEquals(result.guardedSteps, []);
  assertEquals(result.reason?.includes("lack guard expressions"), true);
});

Deno.test("assessRecoveryForRun: guarded unknown steps allow auto-recovery", async () => {
  const wf = createWorkflow({ guard: 'data.latest("m", "d")' });
  const run = WorkflowRun.create(wf);
  run.start();
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  run.interrupt("server_crash");

  const result = await assessRecoveryForRun(wf, run);

  assertEquals(result.canAutoRecover, true);
  assertEquals(result.guardedSteps, ["step1"]);
  assertEquals(result.unguardedSteps, []);
  assertEquals(result.reason, undefined);
});

Deno.test("assessRecoveryForRun: zero unknown steps allows auto-recovery", async () => {
  const wf = createWorkflow();
  const run = WorkflowRun.create(wf);
  run.start();
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  run.jobs[0].steps[0].succeed();
  run.jobs[0].steps[1].start();
  run.jobs[0].steps[1].succeed();
  run.jobs[0].succeed();
  // Crash after all steps completed but before run.complete()
  run.interrupt("server_crash");

  const result = await assessRecoveryForRun(wf, run);

  assertEquals(result.canAutoRecover, true);
  assertEquals(result.guardedSteps.length, 0);
  assertEquals(result.unguardedSteps.length, 0);
});

Deno.test("assessRecoveryForRun: fingerprint mismatch blocks recovery", async () => {
  const wf = createWorkflow();
  const run = createInterruptedRun(wf);
  run.captureRunPlan("mismatched-fingerprint-abc123");

  const result = await assessRecoveryForRun(wf, run);

  assertEquals(result.canAutoRecover, false);
  assertEquals(result.fingerprintMismatch, true);
});

Deno.test("assessRecoveryForRun: no fingerprint skips drift check", async () => {
  const wf = createWorkflow({ guard: 'data.latest("m", "d")' });
  const run = WorkflowRun.create(wf);
  run.start();
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  run.interrupt("server_crash");
  // No captureRunPlan — fingerprint is undefined

  const result = await assessRecoveryForRun(wf, run);

  assertEquals(result.canAutoRecover, true);
  assertEquals(result.fingerprintMismatch, false);
});

Deno.test("assessRecoveryForRun: matching definition fingerprint passes when the evaluated one differs", async () => {
  const wf = createWorkflow({ guard: 'data.latest("m", "d")' });
  const run = createInterruptedRun(wf);
  // Evaluation resolved expressions, so the evaluated fingerprint differs
  // from the definition's while the definition itself is unchanged.
  run.captureRunPlan(
    "evaluated-fingerprint",
    run.id,
    await computeWorkflowFingerprint(wf),
  );

  const result = await assessRecoveryForRun(wf, run);

  assertEquals(result.fingerprintMismatch, false);
  assertEquals(result.canAutoRecover, true);
  assertEquals(result.reason, undefined);
});

Deno.test("assessRecoveryForRun: differing definition fingerprint blocks recovery", async () => {
  const wf = createWorkflow();
  const run = createInterruptedRun(wf);
  run.captureRunPlan(
    await computeWorkflowFingerprint(wf),
    run.id,
    "definition-fingerprint-before-edit",
  );

  const result = await assessRecoveryForRun(wf, run);

  assertEquals(result.fingerprintMismatch, true);
  assertEquals(result.canAutoRecover, false);
  assertEquals(
    result.reason,
    "Workflow definition changed since the run started — start a new run with 'swamp workflow run test-wf'",
  );
});

Deno.test("assessRecoveryForRun: legacy run plan matches when its fingerprint equals the definition's", async () => {
  const wf = createWorkflow({ guard: 'data.latest("m", "d")' });
  const run = createInterruptedRun(wf);
  // Recorded before runs stored a definition fingerprint, for a workflow
  // with no expressions resolved at evaluation.
  run.captureRunPlan(await computeWorkflowFingerprint(wf), run.id);

  const result = await assessRecoveryForRun(wf, run);

  assertEquals(result.fingerprintMismatch, false);
  assertEquals(result.canAutoRecover, true);
});

Deno.test("assessRecoveryForRun: legacy run plan that differs is refused as unconfirmable", async () => {
  const wf = createWorkflow({ guard: 'data.latest("m", "d")' });
  const run = createInterruptedRun(wf);
  run.captureRunPlan("evaluated-fingerprint", run.id);

  const result = await assessRecoveryForRun(wf, run);

  assertEquals(result.fingerprintMismatch, true);
  assertEquals(result.canAutoRecover, false);
  assertEquals(
    result.reason,
    "Run was recorded before swamp stored definition fingerprints, so an unchanged workflow definition cannot be confirmed — start a new run with 'swamp workflow run test-wf'",
  );
});

Deno.test("findInterruptedRun: returns null when no interrupted runs", async () => {
  const wf = createWorkflow();
  const mockRepo: WorkflowRunRepository = {
    findAllByWorkflowId: (_id: WorkflowId) => {
      const run = WorkflowRun.create(wf);
      run.start();
      run.jobs[0].start();
      run.jobs[0].steps[0].start();
      run.jobs[0].steps[0].succeed();
      run.jobs[0].steps[1].start();
      run.jobs[0].steps[1].succeed();
      run.jobs[0].succeed();
      run.complete();
      return [run];
    },
  } as unknown as WorkflowRunRepository;

  const result = await findInterruptedRun(wf, mockRepo);
  assertEquals(result, null);
});

Deno.test("findInterruptedRun: returns matching run by ID", async () => {
  const wf = createWorkflow();
  const run1 = createInterruptedRun(wf);
  const run2 = createInterruptedRun(wf);

  const mockRepo: WorkflowRunRepository = {
    findAllByWorkflowId: (_id: WorkflowId) => Promise.resolve([run1, run2]),
  } as unknown as WorkflowRunRepository;

  const result = await findInterruptedRun(wf, mockRepo, run2.id);
  assertEquals(result?.id, run2.id);
});

Deno.test("findInterruptedRun: returns an interrupted run when no ID specified", async () => {
  const wf = createWorkflow();
  const run1 = createInterruptedRun(wf);
  const run2 = createInterruptedRun(wf);

  const mockRepo: WorkflowRunRepository = {
    findAllByWorkflowId: (_id: WorkflowId) => Promise.resolve([run1, run2]),
  } as unknown as WorkflowRunRepository;

  const result = await findInterruptedRun(wf, mockRepo);
  assertEquals(result !== null, true);
  assertEquals(
    result?.id === run1.id || result?.id === run2.id,
    true,
  );
});
