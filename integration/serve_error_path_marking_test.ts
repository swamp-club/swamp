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
 * A serve-executed run has no command line, so no known values: a path its
 * error names is removed only if it was marked (swamp-club#2830). Drives
 * serve's real run path, `executeWorkflowWithLocks`, with a step whose method
 * throws an error naming a path with a space in its last segment, and checks
 * both entries the run records: the step's child invocation (through the
 * workflow telemetry bridge) and the run's parent invocation.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { markErrorPaths, UserError } from "../src/domain/errors.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { TelemetryEntry } from "../src/domain/telemetry/telemetry_entry.ts";
import type { TelemetryRepository } from "../src/domain/telemetry/repositories.ts";
import { TelemetryService } from "../src/domain/telemetry/telemetry_service.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { consumeStream, withDefaults } from "../src/libswamp/stream.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import {
  clearActiveTelemetryService,
  setActiveTelemetryService,
} from "../src/cli/telemetry_integration.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";

await initializeLogging({});

/** Records what the run wrote, so assertions see real entries. */
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

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-serve-paths-" });
  try {
    await consumeStream(
      repoInit(
        createLibSwampContext({}),
        createRepoInitDeps("20260101.120000.0"),
        {
          path: repoDir,
          force: false,
          version: "20260101.120000.0",
          // No tool scaffolding: the default would write to ~/.claude/skills.
          tools: [],
        },
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
    "serve run: a marked path in a failing step is removed from both telemetry entries",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const type = ModelType.create(`test/marked-paths-${crypto.randomUUID()}`);
    // Outside every directory telemetry could know about, and ending in a
    // word the patterns cannot bound.
    const path = join("/srv", "Acme Corp", "exports", "final report");
    modelRegistry.register({
      type,
      version: "2026.01.01.1",
      globalArguments: z.object({}),
      resources: {},
      methods: {
        fail: {
          description: "throws an error naming a marked path",
          arguments: z.object({}),
          execute: () => {
            throw markErrorPaths(
              new UserError(`Cannot read export ${path}: denied`),
              [path],
            );
          },
        },
      },
    });
    try {
      await withRepo(async (repoDir) => {
        const workflow = Workflow.create({
          name: "marked-paths",
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "export",
                  task: StepTask.directExecution(
                    type.normalized,
                    "exporter",
                    "fail",
                    {},
                  ),
                }),
              ],
            }),
          ],
        });
        await new YamlWorkflowRepository(repoDir).save(workflow);

        const repo = new RecordingRepository();
        setActiveTelemetryService(new TelemetryService(repo, "test"));
        try {
          const ctx = await requireInitializedRepoUnlocked({
            repoDir,
            outputMode: "log",
          });
          await executeWorkflowWithLocks(
            ctx.repoDir,
            ctx.repoContext,
            ctx.datastoreConfig,
            { workflowIdOrName: workflow.name },
            new AbortController().signal,
            () => {},
            ctx.syncService,
            undefined,
            { syncGate: undefined, triggerSource: "schedule" },
          );
        } finally {
          clearActiveTelemetryService();
        }

        const child = repo.saved.find((e) => e.parentInvocationId);
        assert(child, "no child invocation recorded");
        assertEquals(
          child.result.errorMessage,
          "Cannot read export <PATH>: denied",
        );
        for (const entry of repo.saved) {
          const message = entry.result.errorMessage ?? "";
          assertEquals(message.includes("report"), false, message);
          assertEquals(message.includes("Acme"), false, message);
        }
      });
    } finally {
      modelRegistry.invalidateType(type);
    }
  },
});
