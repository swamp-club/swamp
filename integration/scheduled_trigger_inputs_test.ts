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
import type { WorkflowTriggerSource } from "../src/domain/telemetry/mod.ts";
import type { TelemetryEntry } from "../src/domain/telemetry/telemetry_entry.ts";
import type { TelemetryRepository } from "../src/domain/telemetry/repositories.ts";
import { TelemetryService } from "../src/domain/telemetry/telemetry_service.ts";
import {
  clearActiveTelemetryService,
  setActiveTelemetryService,
} from "../src/cli/telemetry_integration.ts";

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
  options?: { triggerSource?: WorkflowTriggerSource },
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
    undefined,
    options,
  );
  return events;
}

/**
 * Minimal spool that records what the run wrote, so the assertions can look
 * at real entries rather than at a mocked sink.
 */
class RecordingRepository implements TelemetryRepository {
  saved: TelemetryEntry[] = [];
  save(entry: TelemetryEntry): Promise<void> {
    this.saved.push(entry);
    return Promise.resolve();
  }
  findByDate(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  findByDateRange(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  deleteOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
  deleteAllOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
  findUnflushed(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  markFlushed(): Promise<boolean> {
    return Promise.resolve(true);
  }
  quarantine(): Promise<void> {
    return Promise.resolve();
  }
  deleteQuarantinedOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
}

/**
 * Installs an active telemetry service for `fn`, mirroring what runCli does
 * for the lifetime of a `swamp serve` process.
 */
async function withTelemetry(
  fn: (repo: RecordingRepository) => Promise<void>,
): Promise<void> {
  const repo = new RecordingRepository();
  setActiveTelemetryService(new TelemetryService(repo, "test"));
  try {
    await fn(repo);
  } finally {
    clearActiveTelemetryService();
  }
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

Deno.test({
  name:
    "scheduled run: records a parent invocation plus child method invocations",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // The whole point of swamp-club#1591: before this, a serve-executed run
    // produced no telemetry at all. Driven through executeWorkflowWithLocks
    // because the sink, the deps factory, and the run generator all have to
    // agree — no unit test spans that.
    await withRepo(async (repoDir) => {
      const workflow = shellWorkflow("scheduled-telemetry", {
        schedule: "0 3 * * *",
        inputs: { projectId: "a6b254a2-0b57-4d0f-bf8b-fef767ab119e" },
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      await withTelemetry(async (repo) => {
        const events = await runViaLocks(repoDir, workflow.name, {
          triggerSource: "schedule",
        });
        assertEquals(events.at(-1)?.kind, "completed");

        const parents = repo.saved.filter((e) => !e.parentInvocationId);
        const children = repo.saved.filter((e) => e.parentInvocationId);

        assertEquals(parents.length, 1);
        assertEquals(parents[0].invocation.command, "workflow");
        assertEquals(parents[0].invocation.subcommand, "run");
        assertEquals(parents[0].result.status, "success");

        // Every entry is attributed to the scheduler, and the children hang
        // off this run rather than off the daemon's process invocation.
        for (const entry of repo.saved) {
          assertEquals(entry.triggerSource, "schedule");
        }
        assertEquals(children.length > 0, true);
        for (const child of children) {
          assertEquals(child.parentInvocationId, parents[0].id);
          assertEquals(child.workflowContext?.workflowName, workflow.name);
        }
      });
    });
  },
});

Deno.test({
  name: "scheduled run: records nothing when no trigger source is supplied",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Library and test callers pass no trigger source, and the interactive
    // CLI has its own binding — neither may start emitting from here.
    await withRepo(async (repoDir) => {
      const workflow = shellWorkflow("untriggered-telemetry", {
        schedule: "0 3 * * *",
        inputs: { projectId: "a6b254a2-0b57-4d0f-bf8b-fef767ab119e" },
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      await withTelemetry(async (repo) => {
        const events = await runViaLocks(repoDir, workflow.name);
        assertEquals(events.at(-1)?.kind, "completed");
        assertEquals(repo.saved.length, 0);
      });
    });
  },
});

Deno.test({
  name: "scheduled run: a failed run records an error parent invocation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Only successes credit downstream, so a failing scheduled run must be
    // recorded as an error rather than silently omitted.
    await withRepo(async (repoDir) => {
      const workflow = shellWorkflow("failing-telemetry", {
        schedule: "0 3 * * *",
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      await withTelemetry(async (repo) => {
        await runViaLocks(repoDir, workflow.name, {
          triggerSource: "schedule",
        });

        const parents = repo.saved.filter((e) => !e.parentInvocationId);
        assertEquals(parents.length, 1);
        assertEquals(parents[0].result.status, "error");
        assertEquals(parents[0].triggerSource, "schedule");
      });
    });
  },
});
