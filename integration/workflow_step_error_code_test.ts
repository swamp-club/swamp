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
 * A coded UserError a model method throws reaches a workflow step with its
 * code, through the real WorkflowExecutionService, DefaultStepExecutor,
 * MethodExecutionService and InProcessExecutor (swamp-club#3773). The
 * execution_service_test case for swamp-club#3748 stubs the StepExecutor, so
 * it never crosses the executor result envelope that dropped the code.
 */

import { assertEquals } from "@std/assert";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { UserError } from "../src/domain/errors.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import type { WorkflowExecutionEvent } from "../src/domain/workflows/execution_events.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { collect } from "../src/libswamp/testing.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

interface StepFailure {
  /** The errorCode on the step's step_failed event. */
  eventCode: string | undefined;
  /** The errorCode on the step in the run record read back from disk. */
  recordCode: string | undefined;
  /** The step's error message in the run record read back from disk. */
  recordError: string | undefined;
}

/**
 * Runs a one-step workflow whose model method throws `thrown`, and returns
 * what the step_failed event and the persisted run record say about it.
 */
async function runFailingStep(thrown: Error): Promise<StepFailure> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-3773-error-code-" });
  // Registered per run: the registry is process-global.
  const type = ModelType.create(`@test/error-code-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.10.22.1",
    methods: {
      fail: {
        description: "Throws the given error",
        arguments: z.object({}),
        execute: () => {
          throw thrown;
        },
      },
    },
  });
  try {
    await initializeTestRepo(dir);
    const repo = createRepositoryContext({ repoDir: dir });
    try {
      await repo.definitionRepo.save(
        type,
        Definition.create({ name: "failing", type: type.normalized }),
      );
      const workflow = Workflow.create({
        name: "failing-flow",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "fail",
                task: StepTask.model("failing", "fail"),
              }),
            ],
          }),
        ],
      });
      await repo.workflowRepo.save(workflow);
      const service = new WorkflowExecutionService(
        repo.workflowRepo,
        repo.workflowRunRepo,
        dir,
        undefined,
        undefined,
        repo.catalogStore,
      );

      const events: WorkflowExecutionEvent[] = await collect(
        service.run(workflow.name),
      );

      const failed = events.find((event) =>
        event.kind === "step_failed" && event.stepId === "fail"
      );
      assertEquals(failed?.kind, "step_failed");
      const saved = await repo.workflowRunRepo.findLatestByWorkflowId(
        workflow.id,
      );
      const step = saved?.getJob("main")?.getStep("fail");
      assertEquals(step?.status, "failed");
      return {
        eventCode: failed?.kind === "step_failed"
          ? failed.errorCode
          : undefined,
        recordCode: step?.errorCode,
        recordError: step?.error,
      };
    } finally {
      repo.catalogStore.close();
    }
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("workflow step error code: a coded UserError a model method throws gives the step its code on step_failed and in the run record (swamp-club#3773)", async () => {
  const failure = await runFailingStep(
    new UserError("intentional failure", "auth_failed"),
  );

  assertEquals(failure, {
    eventCode: "auth_failed",
    recordCode: "auth_failed",
    recordError: "intentional failure",
  });
});

Deno.test("workflow step error code: an uncoded UserError a model method throws gives the step no code", async () => {
  const failure = await runFailingStep(new UserError("intentional failure"));

  assertEquals(failure, {
    eventCode: undefined,
    recordCode: undefined,
    recordError: "intentional failure",
  });
});
