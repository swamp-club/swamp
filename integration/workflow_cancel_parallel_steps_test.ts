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
 * Integration test for a cancelled run whose level holds several model steps
 * (swamp-club#2918). The level stops reading its steps when the abort fires,
 * but the run must not save itself cancelled, and so let the CLI push and
 * exit, before each step's method has saved its method-run record cancelled.
 *
 * The unit tests in execution_service_test.ts pin the wait with an in-memory
 * run repository and tracker. This one wires the stores the CLI uses: the
 * YAML run, output and definition repositories on disk and the SQLite run
 * tracker, and checks the records as `swamp model method history` and
 * `swamp model cancel` would read them.
 */

import { join } from "@std/path";
import { assertEquals, assertExists } from "@std/assert";
import { z } from "zod";
import {
  DefaultStepExecutor,
  type StepExecutionContext,
  type StepExecutor,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import type { WorkflowId } from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-cancel-parallel-" });
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

/** Counts executions in flight, each until its promise has settled. */
class InFlightCountingExecutor implements StepExecutor {
  inFlight = 0;

  constructor(private readonly inner: StepExecutor) {}

  async execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
    this.inFlight++;
    try {
      return await this.inner.execute(step, ctx);
    } finally {
      this.inFlight--;
    }
  }
}

/**
 * Opens `gate` once the save that follows a failed job `main` has been
 * written: the abort has settled the level and the run goes on to record its
 * cancellation. Records, on entry to the save of the cancelled run, how many
 * executions were still in flight, which does not depend on how long the
 * disk writes take.
 */
class GatedYamlRunRepository extends YamlWorkflowRunRepository {
  readonly gate = Promise.withResolvers<void>();
  readonly inFlightAtCancelledSave: number[] = [];

  constructor(repoDir: string, private readonly inFlight: () => number) {
    super(repoDir);
  }

  override async save(workflowId: WorkflowId, run: WorkflowRun): Promise<void> {
    if (run.status === "cancelled") {
      this.inFlightAtCancelledSave.push(this.inFlight());
    }
    await super.save(workflowId, run);
    if (run.status === "running" && run.getJob("main")?.status === "failed") {
      this.gate.resolve();
    }
  }
}

Deno.test("workflow cancel: parallel model steps save their method runs and tracker rows cancelled before the run records its cancellation", async () => {
  await withRepo(async (repoDir) => {
    const abort = new AbortController();
    const executor = new InFlightCountingExecutor(new DefaultStepExecutor());
    const runRepo = new GatedYamlRunRepository(
      repoDir,
      () => executor.inFlight,
    );

    // Both methods start, the cancel fires, and each fails as an
    // interrupted process does once the level has moved on without it.
    let started = 0;
    const modelType = ModelType.create(
      `@test-2918/parallel-${crypto.randomUUID().slice(0, 8)}`,
    );
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({}),
      resources: {},
      methods: {
        execute: {
          description: "stops after the cancel",
          arguments: z.object({}),
          execute: async () => {
            if (++started === 2) abort.abort();
            await runRepo.gate.promise;
            throw new Error("process exited with signal SIGTERM");
          },
        },
      },
    });
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    for (const name of ["sh-a", "sh-b"]) {
      await definitionRepo.save(
        modelType,
        Definition.create({ name, type: modelType.normalized }),
      );
    }

    const workflow = Workflow.create({
      name: "cancel-parallel",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "step-a",
              task: StepTask.model("sh-a", "execute"),
            }),
            Step.create({
              name: "step-b",
              task: StepTask.model("sh-b", "execute"),
            }),
          ],
        }),
      ],
    });
    await new YamlWorkflowRepository(repoDir).save(workflow);

    const tracker = new RunTrackerStore(join(repoDir, "run-tracker.db"));
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    try {
      const service = new WorkflowExecutionService(
        new YamlWorkflowRepository(repoDir),
        runRepo,
        repoDir,
        executor,
        undefined,
        catalogStore,
        undefined,
        undefined,
        undefined,
        undefined,
        tracker,
      );

      let finalStatus: string | undefined;
      for await (
        const event of service.run(workflow.name, { signal: abort.signal })
      ) {
        if (event.kind === "completed" || event.kind === "cancelled") {
          finalStatus = event.run.status;
        }
      }

      assertEquals(finalStatus, "cancelled");
      assertEquals(runRepo.inFlightAtCancelledSave, [0]);
      const outputs = await new YamlOutputRepository(repoDir).findAll(
        modelType,
      );
      assertEquals(outputs.length, 2);
      for (const output of outputs) {
        assertEquals(output.status, "cancelled", output.id);
        assertExists(output.completedAt, output.id);
        assertEquals(tracker.findById(output.id)?.status, "cancelled");
      }
    } finally {
      tracker.close();
      catalogStore.close();
    }
  });
});
