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
 * Workflow steps keep the repo's `autoGc` version caps (swamp-club#3251).
 *
 * Runs go through `executeWorkflowWithLocks`, the path serve's scheduler,
 * webhooks and API runs take, against a real repository whose `.swamp.yaml`
 * sets `autoGc`. The model's resource declares a cap of 3; it is written by a
 * top-level step, from a nested workflow, and by a `rollbackOnFailure` method
 * whose deferred writes are promoted when the step succeeds.
 */

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { z } from "zod";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const CAP = 3;
const RUNS = 5;

const StateSchema = z.object({ run: z.string() });

function registerModel(type: ModelType): void {
  modelRegistry.register({
    type,
    version: "2026.01.01.1",
    resources: {
      state: {
        description: "Capped state",
        schema: StateSchema,
        lifetime: "infinite",
        garbageCollection: CAP,
      },
    },
    methods: {
      write: {
        description: "Writes the state resource",
        arguments: z.object({}),
        execute: async (
          _args: Record<string, unknown>,
          ctx: {
            writeResource?: (
              spec: string,
              name: string,
              data: Record<string, unknown>,
            ) => Promise<unknown>;
          },
        ) => {
          await ctx.writeResource!("state", "state", {
            run: crypto.randomUUID(),
          });
          return {};
        },
      },
      writeAtomic: {
        description: "Writes the state resource as a deferred write",
        rollbackOnFailure: true,
        arguments: z.object({}),
        execute: async (
          _args: Record<string, unknown>,
          ctx: {
            writeResource?: (
              spec: string,
              name: string,
              data: Record<string, unknown>,
            ) => Promise<unknown>;
          },
        ) => {
          await ctx.writeResource!("state", "state", {
            run: crypto.randomUUID(),
          });
          return {};
        },
      },
    },
  });
}

async function withRepo(
  autoGc: boolean,
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-workflow-autogc-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n" +
        `autoGc: ${autoGc}\n`,
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

function singleStep(name: string, task: StepTask): Workflow {
  return Workflow.create({
    name,
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({ name: "write", task })],
    })],
  });
}

/** Saves the workflows, runs the first one RUNS times, returns the versions. */
async function runAndCountVersions(
  repoDir: string,
  type: ModelType,
  modelName: string,
  workflows: Workflow[],
): Promise<number> {
  const workflowRepo = new YamlWorkflowRepository(repoDir);
  for (const workflow of workflows) await workflowRepo.save(workflow);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

  for (let i = 0; i < RUNS; i++) {
    let status: string | undefined;
    await executeWorkflowWithLocks(
      resolved,
      repoContext,
      datastoreConfig,
      { workflowIdOrName: workflows[0].name },
      new AbortController().signal,
      (event: WorkflowRunEvent) => {
        if (event.kind === "completed") status = event.run.status;
      },
      syncService,
      undefined,
      { syncGate: undefined },
    );
    assertEquals(status, "succeeded");
  }

  const definition = await repoContext.definitionRepo.findByNameGlobal(
    modelName,
  );
  if (!definition) throw new Error(`no definition for ${modelName}`);
  const versions = await repoContext.unifiedDataRepo.listVersions(
    type,
    definition.definition.id,
    "state",
  );
  return versions.length;
}

const cases: Array<{
  name: string;
  workflows: (type: ModelType, model: string) => Workflow[];
}> = [
  {
    name: "a plain step",
    workflows: (type, model) => [
      singleStep(
        "plain",
        StepTask.directExecution(type.normalized, model, "write"),
      ),
    ],
  },
  {
    name: "a rollbackOnFailure step",
    workflows: (type, model) => [
      singleStep(
        "atomic",
        StepTask.directExecution(type.normalized, model, "writeAtomic"),
      ),
    ],
  },
  {
    name: "a nested workflow's step",
    workflows: (type, model) => [
      singleStep("parent", StepTask.workflow("child")),
      singleStep(
        "child",
        StepTask.directExecution(type.normalized, model, "write"),
      ),
    ],
  },
];

for (const { name, workflows } of cases) {
  for (const autoGc of [true, false]) {
    Deno.test({
      name: `workflow autoGc: ${name} ${
        autoGc ? "keeps the version cap" : "keeps every version"
      } with autoGc ${autoGc} (swamp-club#3251)`,
      sanitizeOps: false,
      sanitizeResources: false,
      fn: async () => {
        const type = ModelType.create(`test/autogc-${crypto.randomUUID()}`);
        registerModel(type);
        try {
          await withRepo(autoGc, async (repoDir) => {
            const model = "capped";
            const count = await runAndCountVersions(
              repoDir,
              type,
              model,
              workflows(type, model),
            );
            assertEquals(count, autoGc ? CAP : RUNS);
          });
        } finally {
          modelRegistry.invalidateType(type);
        }
      },
    });
  }
}
