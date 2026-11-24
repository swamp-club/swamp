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
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

const WriteArgs = z.object({ key: z.string() });
const ReadArgs = z.object({ value: z.string() });
const KEYS = ["a", "b", "c", "d", "e", "f"];

/** content reads by data name, across every repository instance the run makes */
function countContentReads(): { reads: Map<string, number> } & Disposable {
  const reads = new Map<string, number>();
  const proto = FileSystemUnifiedDataRepository.prototype;
  const original = proto.getContent;
  proto.getContent = function (this: FileSystemUnifiedDataRepository, ...args) {
    const name = args[2];
    reads.set(name, (reads.get(name) ?? 0) + 1);
    return original.apply(this, args);
  };
  return {
    reads,
    [Symbol.dispose]: () => {
      proto.getContent = original;
    },
  };
}

async function withRepo(
  fn: (repo: RepositoryContext, dir: string, received: string[]) => Promise<
    void
  >,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-retention-" });
  const repo = createRepositoryContext({ repoDir: dir });
  const type = ModelType.create(`test/retention-${crypto.randomUUID()}`);
  const received: string[] = [];
  modelRegistry.register({
    type,
    version: "2026.11.24.1",
    resources: {
      blob: {
        description: "One blob per key",
        schema: z.object({ text: z.string() }),
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    methods: {
      write: {
        description: "Write the key's blob",
        arguments: WriteArgs,
        execute: async (args, context) => {
          const { key } = WriteArgs.parse(args);
          const handle = await context.writeResource!("blob", `blob-${key}`, {
            text: key,
          });
          return { dataHandles: [handle] };
        },
      },
      read: {
        description: "Record the value it received",
        arguments: ReadArgs,
        execute: (args) => {
          received.push(ReadArgs.parse(args).value);
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  for (const name of ["writer", "reader"]) {
    await repo.definitionRepo.save(type, Definition.create({ name }));
  }
  try {
    await fn(repo, dir, received);
  } finally {
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function service(repo: RepositoryContext, dir: string) {
  const deps = await createWorkflowRunDeps(dir, repo, {
    type: "filesystem",
    path: join(dir, ".swamp"),
  });
  return deps.createExecutionService(
    repo.workflowRepo,
    repo.workflowRunRepo,
    dir,
    repo.catalogStore,
  );
}

const fanOut = Step.create({
  name: "write-${{ self.k }}",
  task: StepTask.model("writer", "write", { key: "${{ self.k }}" }),
  forEach: { item: "k", in: `\${{ ${JSON.stringify(KEYS)} }}` },
});

function readStep(value: string, after: string): Step {
  return Step.create({
    name: "read",
    task: StepTask.model("reader", "read", { value }),
    dependsOn: [{ step: after, condition: TriggerCondition.succeeded() }],
  });
}

const blobReads = (reads: Map<string, number>) =>
  KEYS.map((key) => reads.get(`blob-${key}`) ?? 0);

Deno.test("workflow memory: a forEach reads back only the resources of the iteration an expression names", async () => {
  await withRepo(async (repo, dir, received) => {
    await repo.workflowRepo.save(Workflow.create({
      name: "fan-named",
      jobs: [Job.create({
        name: "main",
        steps: [
          fanOut,
          readStep(
            "${{ steps['write-c'].outputs.text }}",
            "write-${{ self.k }}",
          ),
        ],
      })],
    }));
    using counter = countContentReads();
    const run = await (await service(repo, dir)).execute("fan-named");
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(received, ["c"]);
    assertEquals(blobReads(counter.reads).map((n) => n > 0), [
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });
});

Deno.test("workflow memory: a computed steps key reads back every iteration", async () => {
  await withRepo(async (repo, dir, received) => {
    await repo.workflowRepo.save(Workflow.create({
      name: "fan-computed",
      jobs: [Job.create({
        name: "main",
        steps: [
          fanOut,
          readStep(
            "${{ steps['write-' + 'e'].outputs.text }}",
            "write-${{ self.k }}",
          ),
        ],
      })],
    }));
    using counter = countContentReads();
    const run = await (await service(repo, dir)).execute("fan-computed");
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(received, ["e"]);
    assertEquals(blobReads(counter.reads).every((n) => n > 0), true);
  });
});

Deno.test("workflow memory: model.NAME.resource still reads the run's own writes", async () => {
  await withRepo(async (repo, dir, received) => {
    await repo.workflowRepo.save(Workflow.create({
      name: "fan-model-map",
      jobs: [Job.create({
        name: "main",
        steps: [
          fanOut,
          readStep(
            "${{ model.writer.resource.blob['blob-f'].attributes.text }}",
            "write-${{ self.k }}",
          ),
        ],
      })],
    }));
    const run = await (await service(repo, dir)).execute("fan-model-map");
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(received, ["f"]);
  });
});

Deno.test("workflow memory: a resumed run reads back only the completed steps an expression names", async () => {
  await withRepo(async (repo, dir, received) => {
    await repo.workflowRepo.save(Workflow.create({
      name: "fan-gated",
      jobs: [Job.create({
        name: "main",
        steps: [
          fanOut,
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Continue?"),
            dependsOn: [{
              step: "write-${{ self.k }}",
              condition: TriggerCondition.succeeded(),
            }],
          }),
          readStep("${{ steps['write-b'].outputs.text }}", "gate"),
        ],
      })],
    }));
    const suspended = await (await service(repo, dir)).execute("fan-gated");
    assertEquals(suspended.status, "suspended");

    const workflowId = createWorkflowId(suspended.workflowId);
    const toApprove = (await repo.workflowRunRepo.findById(
      workflowId,
      suspended.id,
    ))!;
    const gate = toApprove.getJob("main")!.getStep("gate")!;
    gate.recordApprovalDecision({
      approved: true,
      decidedBy: "user:test",
      decidedAt: new Date().toISOString(),
    });
    gate.succeed();
    await repo.workflowRunRepo.save(workflowId, toApprove);

    using counter = countContentReads();
    let resumed: WorkflowRun | undefined;
    for await (
      const event of (await service(repo, dir)).resume(
        "fan-gated",
        suspended.id,
      )
    ) {
      if (event.kind === "completed") resumed = event.run;
    }
    assertEquals(resumed?.status, "succeeded");
    assertEquals(received, ["b"]);
    assertEquals(blobReads(counter.reads).map((n) => n > 0), [
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});
