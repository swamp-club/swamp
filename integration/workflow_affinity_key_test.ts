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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  getRemoteStepDispatcher,
  type RemoteStepRequest,
  setRemoteStepDispatcher,
} from "../src/domain/remote/remote_dispatch.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

interface Recorded {
  /** affinityKey per dispatched step, keyed by step name. */
  keys: Map<string, string | undefined>;
  released: string[];
}

// Runs the workflow against a recording dispatcher and returns the run id
// with the affinity key each remote step carried and every pin released.
async function runRecorded(
  build: (modelName: string) => Workflow,
): Promise<{ runId: string; recorded: Recorded }> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-affinity-key-" });
  const original = getRemoteStepDispatcher();
  let repo: ReturnType<typeof createRepositoryContext> | undefined;
  try {
    repo = createRepositoryContext({ repoDir: dir });
    const type = ModelType.create(`test/affinity-${crypto.randomUUID()}`);
    modelRegistry.register({
      type,
      version: "2026.10.29.1",
      methods: {
        run: {
          description: "No-op; the step is dispatched remotely",
          arguments: z.object({}),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      },
    });
    const recorded: Recorded = { keys: new Map(), released: [] };
    setRemoteStepDispatcher({
      executeRemote: (request: RemoteStepRequest) => {
        recorded.keys.set(
          request.stepName ?? "",
          request.placement.affinityKey,
        );
        return Promise.resolve({ outputs: [], logs: [], durationMs: 0 });
      },
      releaseAffinity: (key) => {
        recorded.released.push(key);
      },
    });
    await repo.definitionRepo.save(type, Definition.create({ name: "target" }));
    const workflow = build("target");
    await repo.workflowRepo.save(workflow);
    const deps = await createWorkflowRunDeps(dir, repo, {
      type: "filesystem",
      path: join(dir, ".swamp"),
    });
    const service = deps.createExecutionService(
      repo.workflowRepo,
      repo.workflowRunRepo,
      dir,
      repo.catalogStore,
    );
    const run = await service.execute(workflow.name, {});
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    return { runId: run.id, recorded };
  } finally {
    setRemoteStepDispatcher(original);
    repo?.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function step(name: string, modelName: string): Step {
  return Step.create({ name, task: StepTask.model(modelName, "run") });
}

Deno.test("workflow affinity: a job with affinity false opts out of the run-wide pin", async () => {
  const { runId, recorded } = await runRecorded((modelName) =>
    Workflow.create({
      name: "affinity-opt-out",
      affinity: true,
      labels: { pool: "test" },
      jobs: [
        Job.create({
          name: "inherits",
          steps: [step("inherited", modelName)],
        }),
        Job.create({
          name: "independent",
          affinity: false,
          steps: [
            Step.create({
              name: "item-${{ self.i }}",
              forEach: { item: "i", in: '${{ ["1", "2"] }}' },
              task: StepTask.model(modelName, "run"),
            }),
          ],
        }),
        Job.create({
          name: "also-pinned",
          affinity: true,
          steps: [step("job-true", modelName)],
        }),
      ],
    })
  );

  assertEquals(
    Object.fromEntries(recorded.keys),
    {
      "inherited": runId,
      "item-1": undefined,
      "item-2": undefined,
      "job-true": runId,
    },
  );
  assertEquals(recorded.released, [runId]);
});

Deno.test("workflow affinity: job-level affinity pins to the job and releases when it ends", async () => {
  const { runId, recorded } = await runRecorded((modelName) =>
    Workflow.create({
      name: "affinity-job-scope",
      labels: { pool: "test" },
      jobs: [
        Job.create({
          name: "pinned",
          affinity: true,
          steps: [step("pinned-step", modelName)],
        }),
        Job.create({
          name: "free",
          steps: [step("free-step", modelName)],
        }),
      ],
    })
  );

  assertEquals(
    Object.fromEntries(recorded.keys),
    {
      "pinned-step": `${runId}:pinned`,
      "free-step": undefined,
    },
  );
  assertEquals(recorded.released, [`${runId}:pinned`]);
});
