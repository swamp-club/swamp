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
 * Integration test for recovering a run serve's shutdown aborted while a
 * step was in flight (swamp-club#3369). Uses a real repository on disk, the
 * detached `workflow.run` handler, the shutdown drain and interrupt stages,
 * the recovery reset and the `workflow.resume` handler.
 */

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { assessRecoveryForRun } from "../src/domain/workflows/recovery_assessment.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import {
  handleWorkflowResume,
  handleWorkflowRun,
} from "../src/serve/handlers/workflow_handlers.ts";
import {
  type ActiveRun,
  ActiveRunRegistry,
} from "../src/serve/active_run_registry.ts";
import {
  runShutdownDrain,
  SHUTDOWN_ABORT_GRACE_MS,
} from "../src/serve/shutdown_drain.ts";
import { interruptShutdownRuns } from "../src/serve/shutdown_interrupt.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const testOpts = { sanitizeOps: false, sanitizeResources: false };

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-shutdown-recover-" });
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

function statuses(run: WorkflowRun): Record<string, string> {
  const result: Record<string, string> = {};
  for (const jobRun of run.jobs) {
    result[jobRun.jobName] = jobRun.status;
    for (const step of jobRun.steps) {
      result[`${jobRun.jobName}/${step.stepName}`] = step.status;
    }
  }
  return result;
}

type Scenario = "plain" | "nested" | "nested-launched-after-abort";

/**
 * Runs the workflow through serve, shuts serve down while the step under
 * test is in flight, and checks the interrupted run recovers and resumes.
 * The run's first job holds the in-flight step and a step that depends on
 * it; a second job depends on the first.
 */
async function interruptRecoverResume(scenario: Scenario): Promise<void> {
  await withRepo(async (repoDir) => {
    const modelType = ModelType.create(
      `test/shutdown-recover-${crypto.randomUUID()}`,
    );
    let waitStarted = false;
    // Set once serve has shut down: the resumed method then finishes.
    let released = false;
    let onTrip: () => void = () => {};
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({}),
      resources: {},
      methods: {
        wait: {
          description: "waits until the run is aborted, then fails",
          arguments: z.object({}),
          execute: (_args, context) => {
            if (released) return Promise.resolve({ dataHandles: [] });
            waitStarted = true;
            return new Promise((_resolve, reject) => {
              context.signal.addEventListener("abort", () => {
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                );
              }, { once: true });
            });
          },
        },
        trip: {
          description: "aborts the run, then succeeds",
          arguments: z.object({}),
          execute: () => {
            if (!released) onTrip();
            return Promise.resolve({ dataHandles: [] });
          },
        },
        quick: {
          description: "succeeds",
          arguments: z.object({}),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      },
    });

    try {
      const child = Workflow.create({
        name: `shutdown-recover-child-${crypto.randomUUID()}`,
        jobs: [Job.create({
          name: "child-job",
          steps: [Step.create({
            name: "slow",
            task: StepTask.model("waiter", "wait"),
          })],
        })],
      });
      const succeeded = (step: string) => [{
        step,
        condition: TriggerCondition.succeeded(),
      }];
      const inFlight = scenario === "plain" ? "slow" : "call-child";
      const steps: Step[] = [];
      if (scenario === "nested-launched-after-abort") {
        steps.push(
          Step.create({ name: "pre", task: StepTask.model("waiter", "trip") }),
        );
      }
      steps.push(Step.create({
        name: inFlight,
        task: scenario === "plain"
          ? StepTask.model("waiter", "wait")
          : StepTask.workflow(child.name),
        dependsOn: scenario === "nested-launched-after-abort"
          ? succeeded("pre")
          : [],
      }));
      steps.push(Step.create({
        name: "after",
        task: StepTask.model("waiter", "quick"),
        dependsOn: succeeded(inFlight),
      }));
      const parent = Workflow.create({
        name: `shutdown-recover-parent-${crypto.randomUUID()}`,
        jobs: [
          Job.create({ name: "main", steps }),
          Job.create({
            name: "later",
            steps: [Step.create({
              name: "fin",
              task: StepTask.model("waiter", "quick"),
            })],
            dependsOn: [{
              job: "main",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      });
      const workflowRepo = new YamlWorkflowRepository(repoDir);
      await workflowRepo.save(child);
      await workflowRepo.save(parent);
      const {
        repoDir: resolved,
        repoContext,
        datastoreConfig,
        datastoreResolver,
        syncService,
      } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
      await repoContext.definitionRepo.save(
        modelType,
        Definition.create({ name: "waiter", type: modelType.normalized }),
      );

      const context = (registry: ActiveRunRegistry) =>
        ({
          repoDir: resolved,
          repoContext,
          datastoreConfig,
          datastoreResolver,
          syncService,
          authConfig: { mode: "none" },
          activeRunRegistry: registry,
        }) as unknown as ConnectionContext;
      const socket = {
        readyState: WebSocket.OPEN,
        send: () => {},
      } as unknown as WebSocket;

      const registry = new ActiveRunRegistry();
      // The shutdown's abort, fired from inside the step before the nested
      // one so the nested step launches its child with the signal aborted.
      let aborted: ReadonlyArray<ActiveRun> = [];
      onTrip = () => {
        aborted = registry.list();
        for (const run of aborted) {
          run.controller.abort(new Error("server shutdown"));
        }
      };

      const handled = handleWorkflowRun(
        socket,
        context(registry),
        "run-1",
        { workflowIdOrName: parent.name, inputs: {} },
        new AbortController(),
        null,
      );
      if (scenario === "nested-launched-after-abort") {
        await handled;
        await waitFor(() => registry.size === 0, "the aborted run to settle");
      } else {
        await waitFor(() => waitStarted, "the in-flight method to start");
        aborted = await runShutdownDrain({
          webhookService: null,
          scheduledExecution: null,
          activeRunRegistry: registry,
          drainTimeoutMs: 0,
          abortGraceMs: SHUTDOWN_ABORT_GRACE_MS,
        });
        await handled;
      }
      assertEquals(aborted.length, 1);
      const result = await interruptShutdownRuns(aborted, { repoContext });
      assertEquals(result.interrupted, [aborted[0].runId]);

      const runRepo = repoContext.workflowRunRepo;
      const parentId = createWorkflowId(parent.id);
      const [interrupted] = await runRepo.findAllByWorkflowId(parentId);
      assertEquals(interrupted.status, "interrupted");
      assertEquals(statuses(interrupted), {
        main: "unknown",
        ...(scenario === "nested-launched-after-abort"
          ? { "main/pre": "succeeded" }
          : {}),
        [`main/${inFlight}`]: "unknown",
        "main/after": "skipped",
        later: "skipped",
        "later/fin": "skipped",
      });
      const childRuns = await runRepo.findAllByWorkflowId(
        createWorkflowId(child.id),
      );
      if (scenario === "plain") {
        assertEquals(childRuns.length, 0);
      } else {
        // The child stays cancelled; the resume starts a fresh one.
        assertEquals(childRuns.map((r) => r.status), ["cancelled"]);
        if (scenario === "nested-launched-after-abort") {
          assertEquals(waitStarted, false);
        }
      }

      const assessment = await assessRecoveryForRun(parent, interrupted);
      assertEquals(assessment.unguardedSteps, [inFlight]);
      assertEquals(assessment.fingerprintMismatch, false);

      interrupted.resetUnknownStepsForRecovery();
      await runRepo.save(parentId, interrupted);
      released = true;
      await handleWorkflowResume(
        socket,
        context(new ActiveRunRegistry()),
        "resume-1",
        { workflowIdOrName: parent.name, runId: interrupted.id },
        new AbortController(),
        null,
      );

      const [resumed] = await runRepo.findAllByWorkflowId(parentId);
      assertEquals(resumed.status, "succeeded");
      assertEquals(
        Object.values(statuses(resumed)).every((s) => s === "succeeded"),
        true,
      );
      if (scenario !== "plain") {
        const after = await runRepo.findAllByWorkflowId(
          createWorkflowId(child.id),
        );
        assertEquals(
          after.map((r) => r.status).sort(),
          ["cancelled", "succeeded"],
        );
      }
    } finally {
      modelRegistry.invalidateType(modelType);
    }
  });
}

Deno.test({
  name:
    "serve shutdown: a plain step it stops in flight is interrupted as unknown, recovers and resumes (swamp-club#3369)",
  ...testOpts,
  fn: () => interruptRecoverResume("plain"),
});

Deno.test({
  name:
    "serve shutdown: a nested workflow step it stops mid-child is interrupted as unknown, recovers and resumes (swamp-club#3369)",
  ...testOpts,
  fn: () => interruptRecoverResume("nested"),
});

Deno.test({
  name:
    "serve shutdown: a nested workflow step launched after the abort is interrupted as unknown, recovers and resumes (swamp-club#3369)",
  ...testOpts,
  fn: () => interruptRecoverResume("nested-launched-after-abort"),
});
