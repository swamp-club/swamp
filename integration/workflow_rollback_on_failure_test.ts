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
 * A `rollbackOnFailure` method runs as a workflow step (swamp-club#3255).
 *
 * Workflow steps write through the composite repository, so the method's
 * deferred writes must reach the store that owns the data. Runs go through
 * `executeWorkflowWithLocks` against a real repository.
 */

import { join } from "@std/path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import type { WorkflowRunView } from "../src/libswamp/workflows/workflow_run_view.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const MODEL_NAME = "atomic";

const MarkerSchema = z.object({ marker: z.string() });

type WriterContext = {
  writeResource?: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

function registerModel(type: ModelType): void {
  modelRegistry.register({
    type,
    version: "2026.01.01.1",
    resources: {
      durable: {
        description: "Persistent marker",
        schema: MarkerSchema,
        lifetime: "infinite",
        garbageCollection: 5,
      },
      scratch: {
        description: "Ephemeral marker",
        schema: MarkerSchema,
        lifetime: "ephemeral",
        garbageCollection: 5,
      },
    },
    methods: {
      succeed: {
        description: "Writes both markers",
        rollbackOnFailure: true,
        arguments: z.object({}),
        execute: async (_args: Record<string, unknown>, ctx: WriterContext) => {
          await ctx.writeResource!("durable", "durable", { marker: "kept" });
          await ctx.writeResource!("scratch", "scratch", { marker: "kept" });
          return {};
        },
      },
      fail: {
        description: "Writes both markers, then throws",
        rollbackOnFailure: true,
        arguments: z.object({}),
        execute: async (_args: Record<string, unknown>, ctx: WriterContext) => {
          await ctx.writeResource!("durable", "durable", { marker: "lost" });
          await ctx.writeResource!("scratch", "scratch", { marker: "lost" });
          throw new Error("method blew up");
        },
      },
    },
  });
}

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-workflow-rollback-",
  });
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

/** Runs `method` as a one-step workflow; returns the run and the versions kept. */
async function runStep(
  repoDir: string,
  type: ModelType,
  method: string,
): Promise<{ run: WorkflowRunView; durableVersions: number[] }> {
  const workflow = Workflow.create({
    name: `run-${method}`,
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "write",
        task: StepTask.directExecution(type.normalized, MODEL_NAME, method),
      })],
    })],
  });
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

  let run: WorkflowRunView | undefined;
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflow.name },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "completed") run = event.run;
    },
    syncService,
    undefined,
    { syncGate: undefined },
  );
  if (!run) throw new Error("workflow run did not complete");

  const definition = await repoContext.definitionRepo.findByNameGlobal(
    MODEL_NAME,
  );
  if (!definition) throw new Error(`no definition for ${MODEL_NAME}`);
  const durableVersions = await repoContext.unifiedDataRepo.listVersions(
    type,
    definition.definition.id,
    "durable",
  );
  return { run, durableVersions };
}

function testWithModel(
  name: string,
  fn: (repoDir: string, type: ModelType) => Promise<void>,
): void {
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const type = ModelType.create(`test/wf-rollback-${crypto.randomUUID()}`);
      registerModel(type);
      try {
        await withRepo((repoDir) => fn(repoDir, type));
      } finally {
        modelRegistry.invalidateType(type);
      }
    },
  });
}

testWithModel(
  "workflow rollbackOnFailure: a succeeding step promotes its writes (swamp-club#3255)",
  async (repoDir, type) => {
    const { run, durableVersions } = await runStep(repoDir, type, "succeed");

    assertEquals(run.status, "succeeded");
    assertEquals(durableVersions, [1]);
  },
);

testWithModel(
  "workflow rollbackOnFailure: a failing step reports its own error and keeps no write (swamp-club#3255)",
  async (repoDir, type) => {
    const { run, durableVersions } = await runStep(repoDir, type, "fail");

    assertEquals(run.status, "failed");
    assertStringIncludes(run.jobs[0].steps[0].error ?? "", "method blew up");
    assertEquals(durableVersions, []);
  },
);
