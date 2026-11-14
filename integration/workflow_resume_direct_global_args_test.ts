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

import { assertEquals, assertExists } from "@std/assert";
import { z } from "zod";
import { createDirectTypeResolver } from "../src/cli/direct_type_resolver.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { collect } from "../src/libswamp/testing.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

interface Fixture {
  repo: RepositoryContext;
  probeType: string;
  writerType: string;
  ranWith: string[];
  service: () => WorkflowExecutionService;
  storedRepoPath: () => Promise<unknown>;
  deleteProbe: () => Promise<void>;
}

const PROBE = "probe-from-step";

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-resume-globals-" });
  const repo = createRepositoryContext({ repoDir: dir });
  const probeType = `test/resume-probe-${crypto.randomUUID()}`;
  const writerType = `test/resume-writer-${crypto.randomUUID()}`;
  const ranWith: string[] = [];
  modelRegistry.register({
    type: ModelType.create(probeType),
    version: "2026.11.14.1",
    globalArguments: z.object({ repoPath: z.string().default(".") }),
    methods: {
      status: {
        description: "Records the repoPath it ran with",
        arguments: z.object({}),
        execute: (_args, context) => {
          ranWith.push(String(context.globalArgs.repoPath));
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  modelRegistry.register({
    type: ModelType.create(writerType),
    version: "2026.11.14.1",
    globalArguments: z.object({}),
    resources: {
      location: {
        description: "A checkout location",
        schema: z.object({ path: z.string() }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
    },
    methods: {
      write: {
        description: "Writes the path it is given",
        arguments: z.object({ path: z.string() }),
        execute: async (args, context) => {
          const handle = await context.writeResource!("location", "main", {
            path: (args as { path: string }).path,
          });
          return { dataHandles: [handle] };
        },
      },
    },
  });
  const freshDefinitions = () =>
    new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      repo.autoDefinitionsDir,
    );
  try {
    await fn({
      repo,
      probeType,
      writerType,
      ranWith,
      service: () =>
        new WorkflowExecutionService(
          repo.workflowRepo,
          repo.workflowRunRepo,
          dir,
          undefined,
          undefined,
          repo.catalogStore,
          createDirectTypeResolver(dir, repo),
        ),
      storedRepoPath: async () => {
        const found = await freshDefinitions().findByNameGlobal(PROBE);
        assertExists(found, `${PROBE} has no stored definition`);
        return found.definition.globalArguments.repoPath;
      },
      deleteProbe: async () => {
        const definitions = freshDefinitions();
        const found = await definitions.findByNameGlobal(PROBE);
        assertExists(found);
        await definitions.delete(found.type, found.definition.id, PROBE);
      },
    });
  } finally {
    modelRegistry.invalidateType(probeType);
    modelRegistry.invalidateType(writerType);
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

// The assert after the probe always fails, so every run can be resumed.
function failingAfter(probe: Step, before: Step[] = []): Workflow {
  return Workflow.create({
    name: "probe",
    inputs: {
      properties: { dir: { type: "string" } },
      required: ["dir"],
    },
    jobs: [Job.create({
      name: "main",
      steps: [
        ...before,
        probe,
        Step.create({
          name: "boom",
          task: StepTask.assert('inputs.dir == "never"', "fails on purpose"),
          dependsOn: [{
            step: "second",
            condition: TriggerCondition.succeeded(),
          }],
        }),
      ],
    })],
  });
}

function probeStep(probeType: string, repoPath: string, after?: string) {
  return Step.create({
    name: "second",
    task: StepTask.directExecution(probeType, PROBE, "status", {}, {
      repoPath,
    }),
    dependsOn: after
      ? [{ step: after, condition: TriggerCondition.succeeded() }]
      : [],
  });
}

Deno.test("workflow resume --from: a direct step whose definition was deleted is recreated with the run's globalArgs", async () => {
  await withFixture(async (f) => {
    const workflow = failingAfter(probeStep(f.probeType, "${{ inputs.dir }}"));
    await f.repo.workflowRepo.save(workflow);
    const run = await f.service().execute(workflow.name, {
      inputs: { dir: "/checkouts/a" },
    });
    assertEquals(run.status, "failed");
    assertEquals(await f.storedRepoPath(), "/checkouts/a");

    await f.deleteProbe();
    await collect(
      f.service().resume(workflow.name, run.id, { fromStep: "second" }),
    );

    assertEquals(await f.storedRepoPath(), "/checkouts/a");
    assertEquals(f.ranWith, ["/checkouts/a", "/checkouts/a"]);
  });
});

Deno.test("workflow resume --from: a direct step uses the resumed run's globalArgs, not a later run's", async () => {
  await withFixture(async (f) => {
    const workflow = failingAfter(probeStep(f.probeType, "${{ inputs.dir }}"));
    await f.repo.workflowRepo.save(workflow);
    const runA = await f.service().execute(workflow.name, {
      inputs: { dir: "/checkouts/a" },
    });
    await f.service().execute(workflow.name, {
      inputs: { dir: "/checkouts/b" },
    });
    assertEquals(await f.storedRepoPath(), "/checkouts/b");

    await collect(
      f.service().resume(workflow.name, runA.id, { fromStep: "second" }),
    );

    assertEquals(await f.storedRepoPath(), "/checkouts/a");
    assertEquals(f.ranWith, ["/checkouts/a", "/checkouts/b", "/checkouts/a"]);
  });
});

Deno.test("workflow resume --from: globalArgs that read an upstream step's output resolve to the resumed run's output", async () => {
  await withFixture(async (f) => {
    const locate = Step.create({
      name: "locate",
      task: StepTask.directExecution(f.writerType, "locator", "write", {
        path: "${{ inputs.dir }}",
      }),
    });
    const workflow = failingAfter(
      probeStep(f.probeType, "${{ steps.locate.outputs.path }}", "locate"),
      [locate],
    );
    await f.repo.workflowRepo.save(workflow);
    const run = await f.service().execute(workflow.name, {
      inputs: { dir: "/checkouts/a" },
    });
    assertEquals(run.status, "failed");
    await f.deleteProbe();

    await collect(
      f.service().resume(workflow.name, run.id, { fromStep: "second" }),
    );

    assertEquals(await f.storedRepoPath(), "/checkouts/a");
    assertEquals(f.ranWith, ["/checkouts/a", "/checkouts/a"]);
  });
});
