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

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { UserError } from "../src/domain/errors.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import {
  remoteGateRefusalUserError,
  requestServerResponse,
  resetRemoteIndicatorMode,
  ServerResponseError,
  setRemoteIndicatorMode,
} from "../src/cli/remote_run.ts";
import {
  MEMBER,
  serveEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";

await initializeLogging({});

const GRANTS: readonly GrantSpec[] = [
  ...MEMBER,
  { actions: ["read", "write", "run"], kind: "workflow", pattern: "*" },
];

const DECISIONS = [
  ["workflow.approve", "workflow_approve_failed"],
  ["workflow.reject", "workflow_reject_failed"],
] as const;

function gatedWorkflow(): Workflow {
  return Workflow.create({
    name: `gated-${crypto.randomUUID().slice(0, 8)}`,
    jobs: [Job.create({
      name: "main",
      steps: [
        Step.create({ name: "build", task: StepTask.model("m", "run") }),
        Step.create({
          name: "gate",
          task: StepTask.manualApproval("Approve?"),
        }),
      ],
    })],
  });
}

/** what the member's `workflow approve` or `reject` raises for serve's answer */
async function decide(
  origin: string,
  type: typeof DECISIONS[number][0],
  failedCode: typeof DECISIONS[number][1],
  payload: Record<string, unknown>,
): Promise<unknown> {
  setRemoteIndicatorMode("json", false);
  try {
    await requestServerResponse(
      { server: origin, token: "alice-token" },
      { type, payload },
    );
  } catch (error) {
    return remoteGateRefusalUserError(error, failedCode);
  } finally {
    resetRemoteIndicatorMode();
  }
  throw new Error(`${type} was not refused`);
}

Deno.test({
  name:
    "serve upstream gate refusal: a member's approve or reject of a step that is not awaiting approval reaches it in the local wording and code, with no server prefix",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: GRANTS });
      const client = await scratch.client("a");
      const workflow = gatedWorkflow();
      const run = WorkflowRun.create(workflow);
      run.start();
      const job = run.getJob("main")!;
      job.start();
      job.getStep("build")!.start();
      job.getStep("build")!.succeed();
      job.getStep("gate")!.start();
      job.getStep("gate")!.waitForApproval("Approve?");
      run.suspend();
      // a workflow's definition is a file of the repository serve runs
      await new YamlWorkflowRepository(serve.serveRepo).save(workflow);
      await writeCommand(
        scratch,
        client,
        serveEnv(serve, "alice-token"),
        async (repos) => {
          await repos.workflowRepo.save(workflow);
          await repos.workflowRunRepo.save(workflow.id, run);
        },
      );

      for (const [type, failedCode] of DECISIONS) {
        const refused = await decide(serve.origin, type, failedCode, {
          workflowIdOrName: workflow.name,
          runId: run.id,
          stepName: "build",
        });
        assertInstanceOf(refused, UserError, type);
        assert(!(refused instanceof ServerResponseError), type);
        assertEquals(
          refused.message,
          'Step "build" is not awaiting approval in the suspended run',
          type,
        );
        assertEquals(refused.code, "validation_failed", type);
      }
    });
  },
});

Deno.test({
  name:
    "serve upstream gate refusal: a refusal whose message serve withholds reaches the member with no local code, still as serve's error",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: GRANTS });
      for (const [type, failedCode] of DECISIONS) {
        const refused = await decide(serve.origin, type, failedCode, {
          workflowIdOrName: "/etc/swamp/gated",
          runId: crypto.randomUUID(),
          stepName: "gate",
        });
        assertInstanceOf(refused, ServerResponseError, type);
        assertEquals(refused.code, failedCode, type);
        assertEquals(refused.serverMessage, "An internal error occurred", type);
        assertEquals(
          (refused.details as { refusalCode?: unknown } | undefined)
            ?.refusalCode,
          undefined,
          type,
        );
        assert(refused.message.startsWith("Server reported "), type);
      }
    });
  },
});
