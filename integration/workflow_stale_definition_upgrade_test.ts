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
 * A workflow step runs a definition whose `typeVersion` is behind its model
 * type (swamp-club#3196).
 *
 * The step's pre-run validation applies the upgrade chain in memory, so a
 * definition still in the old global-argument shape is not refused before the
 * method run that upgrades it. The run then saves the upgraded definition, as
 * a direct method run does. Runs go through `executeWorkflowWithLocks` against
 * a real repository.
 */

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { z } from "zod";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
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

const CURRENT_VERSION = "2026.02.01.1";
const STALE_VERSION = "2026.01.01.1";

/** Registers a type whose one upgrade renames `host` to `target`. */
function registerModel(type: ModelType, seen: unknown[]): void {
  modelRegistry.register({
    type,
    version: CURRENT_VERSION,
    globalArguments: z.object({ target: z.string() }).strict(),
    upgrades: [{
      toVersion: CURRENT_VERSION,
      description: "Rename host to target",
      upgradeAttributes: (old: Record<string, unknown>) => {
        const { host, ...rest } = old;
        return { ...rest, target: host };
      },
    }],
    methods: {
      echo: {
        description: "Records the global arguments it receives",
        arguments: z.object({}),
        execute: (
          _args: Record<string, unknown>,
          ctx: { globalArgs: Record<string, unknown> },
        ) => {
          seen.push(ctx.globalArgs);
          return Promise.resolve({});
        },
      },
    },
  });
}

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-stale-upgrade-" });
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

Deno.test({
  name:
    "workflow step: runs a stale definition and saves it upgraded (swamp-club#3196)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const type = ModelType.create(`test/stale-upgrade-${crypto.randomUUID()}`);
    const seen: unknown[] = [];
    registerModel(type, seen);
    try {
      await withRepo(async (repoDir) => {
        const {
          repoDir: resolved,
          repoContext,
          datastoreConfig,
          syncService,
        } = await requireInitializedRepoUnlocked({
          repoDir,
          outputMode: "log",
        });
        await repoContext.definitionRepo.save(
          type,
          Definition.create({
            name: "stale",
            typeVersion: STALE_VERSION,
            globalArguments: { host: "example" },
          }),
        );
        await new YamlWorkflowRepository(repoDir).save(Workflow.create({
          name: "echo-stale",
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "echo",
              task: StepTask.model("stale", "echo"),
            })],
          })],
        }));

        let status: string | undefined;
        const errors: string[] = [];
        await executeWorkflowWithLocks(
          resolved,
          repoContext,
          datastoreConfig,
          { workflowIdOrName: "echo-stale" },
          new AbortController().signal,
          (event: WorkflowRunEvent) => {
            if (event.kind === "completed") status = event.run.status;
            if (event.kind === "error") errors.push(event.error.message);
          },
          syncService,
          undefined,
          { syncGate: undefined },
        );

        assertEquals(errors, []);
        assertEquals(status, "succeeded");
        assertEquals(seen, [{ target: "example" }]);

        const { repoContext: reread } = await requireInitializedRepoUnlocked({
          repoDir,
          outputMode: "log",
        });
        const saved = await reread.definitionRepo.findByNameGlobal("stale");
        assertEquals(saved?.definition.typeVersion, CURRENT_VERSION);
        assertEquals(saved?.definition.globalArguments, { target: "example" });
      });
    } finally {
      modelRegistry.invalidateType(type);
    }
  },
});
