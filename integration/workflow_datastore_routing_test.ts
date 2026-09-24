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

// swamp-club#2381: workflow runs must write outputs, evaluated definitions
// and evaluated workflows where the readers (built by the repository factory
// and libswamp) look for them — the datastore — and find auto-definitions
// there. Every test uses a filesystem datastore outside the repo's `.swamp/`,
// so a repo-local write is visible as a miss on the reader side.

import { assertEquals, assertExists } from "@std/assert";
import { join, relative } from "@std/path";
import { walk } from "@std/fs/walk";
import { z } from "zod";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  createLibSwampContext,
  createWorkflowEvaluateDeps,
  workflowEvaluate,
} from "../src/libswamp/mod.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import { handleWorkflowApprovals } from "../src/serve/handlers/workflow_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

interface RoutingFixture {
  dir: string;
  datastoreDir: string;
  config: DatastoreConfig;
  resolver: DefaultDatastorePathResolver;
  repo: RepositoryContext;
  type: ModelType;
  executions: unknown[];
}

async function removeDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}

async function withExternalDatastore(
  fn: (fixture: RoutingFixture) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-2381-repo-" });
  const datastoreDir = await Deno.makeTempDir({ prefix: "swamp-2381-ds-" });
  const config: DatastoreConfig = { type: "filesystem", path: datastoreDir };
  const resolver = new DefaultDatastorePathResolver(dir, config);
  const repo = createRepositoryContext({
    repoDir: dir,
    datastoreResolver: resolver,
  });
  const type = ModelType.create(`test/routing-${crypto.randomUUID()}`);
  const executions: unknown[] = [];
  modelRegistry.register({
    type,
    version: "2026.09.24.1",
    methods: {
      run: {
        description: "Record resolved arguments in process",
        arguments: z.object({ value: z.string().optional() }),
        execute: (args) => {
          executions.push(args);
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  try {
    await fn({ dir, datastoreDir, config, resolver, repo, type, executions });
  } finally {
    repo.catalogStore.close();
    await removeDir(dir);
    await removeDir(datastoreDir);
  }
}

/** Files under `root`, relative and sorted; empty when `root` is missing. */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of walk(root, { includeDirs: false })) {
      files.push(relative(root, entry.path));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return files.sort();
}

function workflowWithTask(name: string, task: StepTask): Workflow {
  return Workflow.create({
    name,
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({ name: "capture", task })],
    })],
  });
}

// Built exactly as serve builds it: the datastore config is the one the
// repository context was created with.
async function runWorkflow(
  { dir, config, repo }: RoutingFixture,
  name: string,
  options: { lastEvaluated?: boolean; inputs?: Record<string, unknown> } = {},
): Promise<WorkflowRun> {
  const deps = await createWorkflowRunDeps(dir, repo, config);
  const service = deps.createExecutionService(
    repo.workflowRepo,
    repo.workflowRunRepo,
    dir,
    repo.catalogStore,
  );
  return await service.execute(name, options);
}

Deno.test("workflow datastore routing: a run's outputs and evaluated caches land in the datastore and readers see them", async () => {
  await withExternalDatastore(async (fixture) => {
    const { dir, datastoreDir, repo, type, executions } = fixture;
    await repo.definitionRepo.save(
      type,
      Definition.create({ name: "consumer" }),
    );
    const workflow = workflowWithTask(
      "routed",
      StepTask.model("consumer", "run", { value: "stored" }),
    );
    await repo.workflowRepo.save(workflow);

    const run = await runWorkflow(fixture, workflow.name);
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(executions.length, 1);

    // Readers built by the repository factory — what `model output search`
    // and `model method run --last-evaluated` use — see the workflow's writes.
    assertEquals((await repo.outputRepo.findAll(type)).length, 1);
    assertExists(
      await repo.evaluatedDefinitionRepo.findByName(type, "consumer"),
    );

    const evaluatedWorkflows = await listFiles(
      join(datastoreDir, "workflows-evaluated"),
    );
    assertEquals(
      evaluatedWorkflows.includes(
        join("runs", run.id, "evaluated-workflow.yaml"),
      ),
      true,
      JSON.stringify(evaluatedWorkflows),
    );
    for (
      const subdir of [
        "outputs",
        "definitions-evaluated",
        "workflows-evaluated",
      ]
    ) {
      assertEquals(
        (await listFiles(join(dir, ".swamp", subdir)))
          .filter((f) => f.endsWith(".yaml")),
        [],
        `${subdir} leaked into the repo-local .swamp`,
      );
    }
  });
});

Deno.test("workflow datastore routing: a nested workflow's step output lands in the datastore", async () => {
  await withExternalDatastore(async (fixture) => {
    const { dir, repo, type, executions } = fixture;
    await repo.definitionRepo.save(
      type,
      Definition.create({ name: "consumer" }),
    );
    await repo.workflowRepo.save(
      workflowWithTask(
        "child",
        StepTask.model("consumer", "run", { value: "nested" }),
      ),
    );
    await repo.workflowRepo.save(
      workflowWithTask("parent", StepTask.workflow("child")),
    );

    const run = await runWorkflow(fixture, "parent");
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(executions, [{ value: "nested" }]);
    assertEquals((await repo.outputRepo.findAll(type)).length, 1);
    assertEquals(
      (await listFiles(join(dir, ".swamp", "outputs")))
        .filter((f) => f.endsWith(".yaml")),
      [],
    );
  });
});

Deno.test("workflow datastore routing: workflow evaluate then a --last-evaluated run replays the datastore copy", async () => {
  await withExternalDatastore(async (fixture) => {
    const { dir, resolver, repo, type, executions } = fixture;
    await repo.definitionRepo.save(
      type,
      Definition.create({ name: "consumer" }),
    );
    const workflow = workflowWithTask(
      "evaluated",
      StepTask.model("consumer", "run", { value: "${{ inputs.value }}" }),
    );
    await repo.workflowRepo.save(workflow);
    // A replay needs the model's evaluated definition too; a fresh run
    // writes it.
    const fresh = await runWorkflow(fixture, workflow.name, {
      inputs: { value: "from-run" },
    });
    assertEquals(fresh.status, "succeeded", JSON.stringify(fresh.toData()));

    const events = await collect(workflowEvaluate(
      createLibSwampContext(),
      createWorkflowEvaluateDeps(dir, repo.workflowRepo, resolver),
      { workflowIdOrName: workflow.name, inputs: { value: "from-evaluate" } },
    ));
    assertEquals(events.at(-1)?.kind, "completed", JSON.stringify(events));

    const run = await runWorkflow(fixture, workflow.name, {
      lastEvaluated: true,
    });
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(executions, [{ value: "from-run" }, {
      value: "from-evaluate",
    }]);
  });
});

Deno.test("workflow datastore routing: a step resolves an auto-definition created by direct type execution", async () => {
  await withExternalDatastore(async (fixture) => {
    const { datastoreDir, repo, type, executions } = fixture;
    await repo.workflowRepo.save(
      workflowWithTask(
        "create-auto",
        StepTask.directExecution(type.normalized, "auto-consumer", "run", {
          value: "direct",
        }),
      ),
    );
    await repo.workflowRepo.save(
      workflowWithTask("use-auto", StepTask.model("auto-consumer", "run")),
    );

    const created = await runWorkflow(fixture, "create-auto");
    assertEquals(created.status, "succeeded", JSON.stringify(created.toData()));
    assertEquals(
      (await listFiles(join(datastoreDir, "auto-definitions"))).length,
      1,
    );

    const used = await runWorkflow(fixture, "use-auto");
    assertEquals(used.status, "succeeded", JSON.stringify(used.toData()));
    assertEquals(executions, [{ value: "direct" }, {}]);
  });
});

interface ApprovalsFrame {
  type: string;
  payload?: { data: { approvals?: Array<{ prompt?: string }> } };
}

Deno.test("workflow datastore routing: serve approvals read the evaluated prompt from the datastore", async () => {
  await withExternalDatastore(async (fixture) => {
    const { dir, resolver, repo } = fixture;
    const workflow = Workflow.create({
      name: "gated",
      inputs: {
        properties: { target: { type: "string" } },
        required: ["target"],
      },
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "approve",
          task: StepTask.manualApproval("Approve ${{ inputs.target }}"),
        })],
      })],
    });
    await repo.workflowRepo.save(workflow);
    const run = await runWorkflow(fixture, workflow.name, {
      inputs: { target: "prod" },
    });
    assertEquals(run.status, "suspended", JSON.stringify(run.toData()));

    // A run suspended before its step recorded the prompt: approvals fall
    // back to the evaluated workflow, which the run wrote to the datastore.
    const data = run.toData();
    for (const job of data.jobs) {
      for (const step of job.steps) delete step.approvalPrompt;
    }
    await repo.workflowRunRepo.save(workflow.id, WorkflowRun.fromData(data));

    const frames: ApprovalsFrame[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (message: string) => frames.push(JSON.parse(message)),
    } as unknown as WebSocket;
    const ctx = {
      authConfig: { mode: "none" },
      repoDir: dir,
      repoContext: repo,
      datastoreResolver: resolver,
    } as unknown as ConnectionContext;
    await handleWorkflowApprovals(
      socket,
      ctx,
      "req-1",
      new AbortController(),
      null,
    );

    assertEquals(frames.length, 1, JSON.stringify(frames));
    assertEquals(frames[0].type, "workflow.approvals", JSON.stringify(frames));
    assertEquals(
      frames[0].payload?.data.approvals?.map((a) => a.prompt),
      ["Approve prod"],
    );
  });
});
