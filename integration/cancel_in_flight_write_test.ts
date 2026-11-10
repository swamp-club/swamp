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
import { assertEquals, assertExists } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { getRegisteredLockKeys } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { createSyncGate } from "../src/serve/sync_gate.ts";

await initializeLogging({});

// both steps take turns on one behavior instance's model lock
Deno.test("cancel: a step queued on a sibling's model lock never starts once the run is cancelled, the sibling's write lands, and no lock is left", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cancel-write-" });
  let instance:
    | Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>
    | undefined;
  try {
    const homeDir = join(dir, "home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    instance = await requireInitializedRepoUnlocked({
      repoDir: dir,
      outputMode: "json",
    });
    const { repoContext, datastoreConfig } = instance;

    const controller = new AbortController();
    const bodies: string[] = [];
    const modelType = ModelType.create(
      `@test-cancel/writer-${crypto.randomUUID().slice(0, 8)}`,
    );
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({}),
      resources: {
        record: {
          description: "the side effect's record",
          schema: z.object({ call: z.number() }),
          lifetime: "infinite",
          garbageCollection: 10,
        },
      },
      methods: {
        touch: {
          description: "cancels the run, then records its side effect",
          arguments: z.object({}),
          execute: async (_args, context) => {
            bodies.push(context.methodName);
            controller.abort(new Error("run cancelled"));
            const handle = await context.writeResource!("record", "record", {
              call: bodies.length,
            });
            return { dataHandles: [handle] };
          },
        },
      },
    });
    const definition = Definition.create({
      name: "writer",
      type: modelType.normalized,
    });
    await repoContext.definitionRepo.save(modelType, definition);
    await repoContext.workflowRepo.save(Workflow.create({
      name: "queued-cancel",
      jobs: [
        Job.create({
          name: "main",
          steps: ["first", "second"].map((name) =>
            Step.create({
              name,
              task: StepTask.modelMethod(definition.name, "touch"),
            })
          ),
        }),
      ],
    }));

    let outcome: string | undefined;
    await executeWorkflowWithLocks(
      dir,
      repoContext,
      datastoreConfig,
      { workflowIdOrName: "queued-cancel", inputs: {} },
      controller.signal,
      (event: WorkflowRunEvent) => {
        if (event.kind === "cancelled") outcome = event.run.status;
      },
      instance.syncService,
      undefined,
      { syncGate: createSyncGate() },
    );

    assertEquals(outcome, "cancelled");
    assertEquals(bodies.length, 1);
    const record = await repoContext.unifiedDataRepo.findByName(
      modelType,
      definition.id,
      "record",
    );
    assertExists(record);
    assertEquals(
      getRegisteredLockKeys().filter((key) => key.includes(definition.id)),
      [],
    );
    const leftLocks: string[] = [];
    for await (
      const entry of walk(dir, { includeDirs: false, match: [/\.lock$/] })
    ) {
      if (entry.path.includes(definition.id)) leftLocks.push(entry.path);
    }
    assertEquals(leftLocks, []);
  } finally {
    instance?.repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
