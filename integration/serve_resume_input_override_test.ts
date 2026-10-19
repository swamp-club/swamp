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

/**
 * A serve resume cannot change an input a finished step read
 * (swamp-club#3583). Through serve's real handlers against a real
 * repository: the run's gate read `target` and its approval showed it, so a
 * resume that changes `target` is refused before the guarded step runs, and
 * the run stays suspended with the value its approval saw.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import {
  approveAs,
  loadRun,
  ROOT,
  saveDefinition,
  sendAs,
  withVaultScopeFixture,
} from "./serve_run_vault_scope_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

function gatedDestroy(): Workflow {
  return Workflow.create({
    name: "gated-destroy",
    autoResume: false,
    inputs: {
      properties: { target: { type: "string" } },
      required: ["target"],
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.model("reader", "read", {
              value: "gate ${{ inputs.target }}",
            }),
          }),
          Step.create({
            name: "approve",
            task: StepTask.manualApproval("Destroy ${{ inputs.target }}?"),
            dependsOn: [
              { step: "gate", condition: TriggerCondition.succeeded() },
            ],
          }),
          Step.create({
            name: "destroy",
            task: StepTask.model("reader", "read", {
              value: "destroy ${{ inputs.target }}",
            }),
            dependsOn: [
              { step: "approve", condition: TriggerCondition.succeeded() },
            ],
          }),
        ],
      }),
    ],
  });
}

Deno.test({
  name:
    "serve resume: an --input the gate and approval already read is refused (swamp-club#3583)",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      await saveDefinition(f, "reader");
      const workflow = gatedDestroy();
      await f.repo.repoContext.workflowRepo.save(workflow);
      await sendAs(f.ctx, "workflow.run", {
        workflowIdOrName: workflow.name,
        inputs: { target: "scratch" },
      }, ROOT);
      const suspended = await f.repo.repoContext.workflowRunRepo
        .findLatestByWorkflowId(createWorkflowId(workflow.id));
      assertEquals(suspended?.status, "suspended");
      await approveAs(f, workflow, suspended!.id, "approve", ROOT);

      const frames = await sendAs(f.ctx, "workflow.resume", {
        workflowIdOrName: workflow.name,
        runId: suspended!.id,
        inputs: { target: "protected" },
      }, ROOT);

      const error = frames.find((frame) => frame.type === "error")?.error;
      assertEquals(error?.code, "workflow_resume_failed");
      assertStringIncludes(
        error?.message ?? "",
        'Input "target" was already used by steps "gate", "approve"',
      );
      assertEquals(f.seen, ["gate scratch"]);
      const after = await loadRun(f, workflow, suspended!.id);
      assertEquals(after?.status, "suspended");
      assertEquals(after?.inputs, { target: "scratch" });
    }),
});
