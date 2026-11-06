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
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { type DataHandle, modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RESOURCE_ATTRIBUTE_CAP_BYTES } from "../src/domain/models/resource_attribute_budget.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  modelMethodRun,
  type ModelMethodRunEvent,
} from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
} from "../src/libswamp/workflows/history_get.ts";
import { workflowRun } from "../src/libswamp/workflows/run.ts";
import type { WorkflowRunView } from "../src/libswamp/workflows/workflow_run_view.ts";
import {
  createModelMethodRunDeps,
  createWorkflowRunDeps,
} from "../src/serve/deps.ts";

await initializeLogging({});

const ITEM_COUNT = 6;
const ITEM = { blob: "x".repeat(1000) };
const ITEM_BYTES = JSON.stringify(ITEM).length;
// room for two items and part of a third
const CAP_BYTES = ITEM_BYTES * 2 + Math.floor(ITEM_BYTES / 2);
const OMITTED_PAST_TWO = [false, false, true, true, true, true];

type Repo = ReturnType<typeof createRepositoryContext>;

interface Fixture {
  dir: string;
  repo: Repo;
  type: ModelType;
  definition: Definition;
  returned: DataHandle[];
}

async function withBulkModel(fn: (fx: Fixture) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-attr-budget-" });
  const type = ModelType.create(`test/attr-budget-${crypto.randomUUID()}`);
  const definition = Definition.create({ name: "bulk", type: type.normalized });
  const returned: DataHandle[] = [];
  modelRegistry.register({
    type,
    version: "2026.11.06.1",
    resources: {
      item: {
        description: "One written item",
        schema: z.object({ blob: z.string() }),
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    methods: {
      write: {
        description: "Write many items",
        arguments: z.object({}),
        execute: async (_args, context) => {
          for (let i = 0; i < ITEM_COUNT; i++) {
            returned.push(
              await context.writeResource!("item", `item-${i}`, { ...ITEM }),
            );
          }
          return { dataHandles: returned };
        },
      },
      writeLarge: {
        description: "Write one item past the default cap, then a small one",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const large = await context.writeResource!("item", "large", {
            blob: "x".repeat(RESOURCE_ATTRIBUTE_CAP_BYTES),
          });
          const small = await context.writeResource!("item", "small", {
            ...ITEM,
          });
          return { dataHandles: [large, small] };
        },
      },
    },
  });
  try {
    await Deno.mkdir(join(dir, "models"), { recursive: true });
    await new RepoMarkerRepository().write(RepoPath.create(dir), {
      swampVersion: "0.1.0",
      initializedAt: "2026-11-06T00:00:00.000Z",
      repoId: crypto.randomUUID(),
      tools: [],
    });
    const repo = createRepositoryContext({ repoDir: dir });
    try {
      await repo.definitionRepo.save(type, definition);
      await fn({ dir, repo, type, definition, returned });
    } finally {
      repo.catalogStore.close();
    }
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else await Deno.remove(dir, { recursive: true });
  }
}

async function assertItemsWritten(fx: Fixture) {
  for (let i = 0; i < ITEM_COUNT; i++) {
    const bytes = await fx.repo.unifiedDataRepo.getContent(
      fx.type,
      fx.definition.id,
      `item-${i}`,
    );
    assertExists(bytes, `item-${i}`);
    assertEquals(JSON.parse(new TextDecoder().decode(bytes)), ITEM);
  }
}

Deno.test("resource attribute budget: a method run past the cap succeeds, keeps later handles light and marks their artifacts omitted", async () => {
  await withBulkModel(async (fx) => {
    const deps = await createModelMethodRunDeps(fx.dir, fx.repo);
    deps.resourceAttributeCapBytes = CAP_BYTES;
    deps.createExecutionService = () =>
      new DefaultMethodExecutionService(CAP_BYTES);

    const events = await collect<ModelMethodRunEvent>(
      modelMethodRun(createLibSwampContext(), deps, {
        modelIdOrName: "bulk",
        methodName: "write",
        inputs: {},
        lastEvaluated: false,
      }),
    );

    const last = events.at(-1);
    assert(last?.kind === "completed", JSON.stringify(last));
    assertEquals(last.run.status, "succeeded");
    const items = last.run.dataArtifacts.filter((a) =>
      a.name.startsWith("item-")
    );
    assertEquals(items.length, ITEM_COUNT);
    assertEquals(
      items.map((a) => a.attributesOmitted === true),
      OMITTED_PAST_TWO,
    );
    assertEquals(items[0].attributes, ITEM);
    assertEquals(items[2].attributes, undefined);
    assertEquals(
      JSON.parse(JSON.stringify(last.run)).dataArtifacts.length,
      last.run.dataArtifacts.length,
    );
    assertEquals(
      fx.returned.map((h) => h.attributes === undefined),
      OMITTED_PAST_TWO,
    );
    await assertItemsWritten(fx);

    const summaryBytes = await fx.repo.unifiedDataRepo.getContent(
      fx.type,
      fx.definition.id,
      "report-swamp-method-summary-json",
    );
    assertExists(summaryBytes);
    const summary = JSON.parse(new TextDecoder().decode(summaryBytes));
    assertEquals(summary.status, "succeeded");
  });
});

Deno.test("resource attribute budget: a workflow run past the cap completes with later artifacts marked omitted", async () => {
  await withBulkModel(async (fx) => {
    const deps = await createWorkflowRunDeps(fx.dir, fx.repo, {
      type: "filesystem",
      path: join(fx.dir, ".swamp"),
    });
    deps.resolveCompletedOutputs = true;
    deps.resourceAttributeCapBytes = CAP_BYTES;
    const workflow = Workflow.create({
      name: `bulk-${crypto.randomUUID()}`,
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "write",
            task: StepTask.model("bulk", "write", {}),
          }),
        ],
      })],
    });
    await fx.repo.workflowRepo.save(workflow);

    const events = await collect(
      workflowRun(createLibSwampContext(), deps, {
        workflowIdOrName: workflow.name,
      }),
    );

    const last = events.at(-1);
    assert(last?.kind === "completed", JSON.stringify(last));
    assertEquals(last.run.status, "succeeded");
    const items = last.run.jobs[0].steps[0].dataArtifacts!.filter((a) =>
      a.name.startsWith("item-")
    );
    assertEquals(items.length, ITEM_COUNT);
    assertEquals(
      items.map((a) => a.attributesOmitted === true),
      OMITTED_PAST_TWO,
    );
    assertEquals(items[0].attributes, ITEM);
    assertEquals(items[2].attributes, undefined);
    assertEquals(
      JSON.parse(JSON.stringify(last.run)).jobs[0].steps[0].dataArtifacts
        .length,
      last.run.jobs[0].steps[0].dataArtifacts!.length,
    );
    await assertItemsWritten(fx);
  });
});

async function historyOf(
  fx: Fixture,
  workflow: string,
  allAttributes: boolean,
): Promise<WorkflowRunView> {
  const deps = createWorkflowHistoryGetDeps(
    fx.dir,
    undefined,
    fx.repo.workflowRepo,
  );
  let view: WorkflowRunView | undefined;
  for await (
    const event of workflowHistoryGet(createLibSwampContext(), deps, workflow, {
      includeOutputs: true,
      allAttributes,
    })
  ) {
    if (event.kind === "completed") view = event.data;
    if (event.kind === "error") throw new Error(event.error.message);
  }
  assertExists(view);
  return view;
}

Deno.test("resource attribute budget: workflow history get bounds a large run, and allAttributes still reads it whole", async () => {
  await withBulkModel(async (fx) => {
    const deps = await createWorkflowRunDeps(fx.dir, fx.repo, {
      type: "filesystem",
      path: join(fx.dir, ".swamp"),
    });
    const workflow = Workflow.create({
      name: `large-${crypto.randomUUID()}`,
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "write",
            task: StepTask.model("bulk", "writeLarge", {}),
          }),
        ],
      })],
    });
    await fx.repo.workflowRepo.save(workflow);
    const events = await collect(
      workflowRun(createLibSwampContext(), deps, {
        workflowIdOrName: workflow.name,
      }),
    );
    assertEquals(events.at(-1)?.kind, "completed");

    const bounded = await historyOf(fx, workflow.name, false);
    const step = bounded.jobs[0].steps[0];
    const byName = new Map(step.dataArtifacts!.map((a) => [a.name, a]));
    assertEquals(byName.get("large")?.attributesOmitted, true);
    assertEquals(byName.get("small")?.attributesOmitted, true);
    assertEquals(byName.get("large")?.attributes, undefined);
    assertEquals(step.outputsPartial, true);
    assert(JSON.stringify(bounded).length < RESOURCE_ATTRIBUTE_CAP_BYTES);

    const whole = await historyOf(fx, workflow.name, true);
    const wholeStep = whole.jobs[0].steps[0];
    assertEquals(wholeStep.outputsPartial, undefined);
    assertEquals(wholeStep.outputs, ITEM);
  });
});
