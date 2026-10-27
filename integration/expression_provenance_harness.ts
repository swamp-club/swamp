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

// Shared harness for the expression provenance tests (swamp-club#3205): a
// throwaway repository with a model type that records the arguments its
// method receives, run through the model-run and workflow-run paths.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/data.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Step } from "../src/domain/workflows/step.ts";
import type { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  createModelMethodRunDeps,
  createWorkflowRunDeps,
} from "../src/serve/deps.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { workflowRun } from "../src/libswamp/workflows/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import "../src/domain/models/models.ts";

export type RepositoryContext = ReturnType<typeof createRepositoryContext>;

export const ENV = {
  SECRET: "runtime-secret",
  OTHER: "runtime-other",
};

export interface Harness {
  repo: RepositoryContext;
  dir: string;
  type: ModelType;
  executions: Record<string, unknown>[];
  /** The global arguments each execution saw, when all of them resolved. */
  globals: Record<string, unknown>[];
}

export async function withRepo(
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-provenance-" });
  const repo = createRepositoryContext({ repoDir: dir });
  const type = ModelType.create(`test/provenance-${crypto.randomUUID()}`);
  const executions: Record<string, unknown>[] = [];
  const globals: Record<string, unknown>[] = [];
  modelRegistry.register({
    type,
    version: "2026.10.12.1",
    globalArguments: z.object({ label: z.string().optional() }),
    methods: {
      run: {
        description: "Capture resolved arguments in process",
        arguments: z.object({
          value: z.string().optional(),
          authored: z.string().optional(),
        }),
        execute: (args, context) => {
          executions.push(args as Record<string, unknown>);
          try {
            globals.push({ ...context.globalArgs });
          } catch {
            // Reading an unresolved global argument throws; those runs are
            // asserted through `executions` alone.
          }
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  try {
    await withMockedEnv(
      ENV,
      () => fn({ repo, dir, type, executions, globals }),
    );
  } finally {
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

export async function runModel(
  dir: string,
  inputs: Record<string, unknown> = {},
  options: {
    literalInputs?: boolean;
    lastEvaluated?: boolean;
    typeArg?: string;
    definitionName?: string;
    expectError?: string;
  } = {},
): Promise<void> {
  const repo = createRepositoryContext({ repoDir: dir });
  try {
    const deps = await createModelMethodRunDeps(dir, repo, {
      directExecution: options.typeArg !== undefined,
    });
    const events = await collect(modelMethodRun(createLibSwampContext(), deps, {
      modelIdOrName: options.definitionName ?? "consumer",
      methodName: "run",
      inputs,
      literalInputs: options.literalInputs,
      lastEvaluated: options.lastEvaluated ?? false,
      typeArg: options.typeArg,
      definitionName: options.definitionName,
    }));
    const errors = events.filter((e) => e.kind === "error");
    if (options.expectError) {
      assertEquals(errors.length, 1);
      assertStringIncludes(
        JSON.stringify(errors[0]),
        options.expectError,
      );
      return;
    }
    assertEquals(errors, []);
    assertEquals(events.at(-1)?.kind, "completed");
  } finally {
    repo.catalogStore.close();
  }
}

export async function runWorkflow(
  h: Harness,
  workflow: Workflow,
  inputs: Record<string, unknown> = {},
  expected: "succeeded" | "failed" = "succeeded",
  lastEvaluated = false,
): Promise<void> {
  if (!lastEvaluated) await h.repo.workflowRepo.save(workflow);
  const deps = await createWorkflowRunDeps(h.dir, h.repo, {
    type: "filesystem",
    path: join(h.dir, ".swamp"),
  });
  const events = await collect(
    workflowRun(createLibSwampContext(), deps, {
      workflowIdOrName: workflow.name,
      inputs,
      lastEvaluated,
    }),
  );
  assertEquals(events.filter((e) => e.kind === "error"), []);
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(
    (completed as { run?: { status?: string } } | undefined)?.run?.status,
    expected,
  );
}

export function workflowOf(
  name: string,
  steps: Step[],
  inputs?: Record<string, unknown>,
): Workflow {
  return Workflow.create({
    name,
    ...(inputs ? { inputs } : {}),
    jobs: [Job.create({ name: "main", steps })],
  });
}

export const TEXT_INPUT = {
  type: "object",
  properties: { text: { type: "string" } },
};

export async function readTree(dir: string): Promise<string> {
  let all = "";
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) all += await readTree(path);
    else if (entry.isFile) all += await Deno.readTextFile(path).catch(() => "");
  }
  return all;
}

export function oneStepWorkflow(
  task: StepTask,
  inputs?: Record<string, unknown>,
): Workflow {
  return Workflow.create({
    name: `flow-${crypto.randomUUID().slice(0, 8)}`,
    ...(inputs ? { inputs } : {}),
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({ name: "capture", task })],
    })],
  });
}

export function consumer(
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Definition {
  return Definition.create({
    name: "consumer",
    inputs: {
      type: "object",
      properties: {
        value: { type: "string" },
        token: { type: "string" },
      },
    },
    ...extra,
    methods: { run: { arguments: args } },
  });
}

export async function saveData(
  h: Harness,
  attributes: Record<string, unknown>,
): Promise<void> {
  const producer = Definition.create({ name: "producer" });
  await h.repo.definitionRepo.save(h.type, producer);
  const data = Data.create({
    name: "notes",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "state", modelName: producer.name },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${h.type.normalized}:${producer.id}`,
    },
  });
  await h.repo.unifiedDataRepo.save(
    h.type,
    producer.id,
    data,
    new TextEncoder().encode(JSON.stringify(attributes)),
  );
}
