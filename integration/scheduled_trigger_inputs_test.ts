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
 * Integration tests for `trigger.inputs` on scheduled/webhook workflows.
 *
 * Scheduled and webhook runs both flow through `executeWorkflowWithLocks` with
 * no caller-supplied inputs. These tests drive that function directly (rather
 * than waiting on a real cron tick) to verify that a workflow's declared
 * `trigger.inputs` are injected as baseline inputs at fire time.
 */

import { assertEquals } from "@std/assert";
import {
  consumeStream,
  createLibSwampContext,
  createRepoInitDeps,
  repoInit,
  withDefaults,
} from "../src/libswamp/mod.ts";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const requiredInputSchema = {
  type: "object" as const,
  properties: { projectId: { type: "string" as const } },
  required: ["projectId"],
};

function shellWorkflow(
  name: string,
  trigger: { schedule?: string; inputs?: Record<string, unknown> } | undefined,
): Workflow {
  return Workflow.create({
    name,
    trigger,
    inputs: requiredInputSchema,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "echo",
            task: StepTask.directExecution(
              "command/shell",
              `${name}-shell`,
              "execute",
              { run: "echo trigger-inputs-ok" },
            ),
          }),
        ],
      }),
    ],
  });
}

async function runViaLocks(
  repoDir: string,
  workflowName: string,
): Promise<WorkflowRunEvent[]> {
  const {
    repoDir: resolvedRepoDir,
    repoContext,
    datastoreConfig,
    syncService,
  } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

  const events: WorkflowRunEvent[] = [];
  await executeWorkflowWithLocks(
    resolvedRepoDir,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflowName },
    new AbortController().signal,
    (event) => events.push(event),
    syncService,
  );
  return events;
}

async function withRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-trigger-inputs-",
  });
  try {
    await consumeStream(
      repoInit(
        createLibSwampContext({}),
        createRepoInitDeps("20260101.120000.0"),
        { path: repoDir, force: false, version: "20260101.120000.0" },
      ),
      withDefaults({
        error: (event) => {
          throw new Error(String(event.error?.message ?? "repo init failed"));
        },
      }),
    );
    await fn(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "scheduled run: a required input supplied only via trigger.inputs resolves and the run completes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = shellWorkflow("scheduled-with-trigger-inputs", {
        schedule: "0 3 * * *",
        inputs: { projectId: "a6b254a2-0b57-4d0f-bf8b-fef767ab119e" },
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      const events = await runViaLocks(repoDir, workflow.name);
      const kinds = events.map((e) => e.kind);

      assertEquals(
        kinds.some((k) => k === "error"),
        false,
        `unexpected error event: ${JSON.stringify(events)}`,
      );
      assertEquals(kinds.at(-1), "completed");
    });
  },
});

Deno.test({
  name:
    "scheduled run: a required input with no trigger.inputs still fails validation with a clear error",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = shellWorkflow("scheduled-missing-input", {
        schedule: "0 3 * * *",
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      const events = await runViaLocks(repoDir, workflow.name);
      const errorEvent = events.find(
        (e): e is Extract<WorkflowRunEvent, { kind: "error" }> =>
          e.kind === "error",
      );

      assertEquals(errorEvent?.error.code, "input_validation_failed");
    });
  },
});
