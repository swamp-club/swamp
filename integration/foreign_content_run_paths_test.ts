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
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import type { ForeignContentFetcher } from "../src/domain/data/repositories.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RunSensitiveValues } from "../src/domain/secrets/mod.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { CatalogRow } from "../src/infrastructure/persistence/catalog_store.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createModelEvaluateDeps } from "../src/libswamp/models/evaluate.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createWorkflowEvaluateDeps,
  workflowEvaluate,
  type WorkflowEvaluateEvent,
} from "../src/libswamp/workflows/evaluate.ts";
import {
  createModelMethodRunDeps,
  createWorkflowRunDeps,
} from "../src/serve/deps.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

const FOREIGN_READ =
  '${{ data.latest("security:scanner", "output").attributes.content }}';

interface Fixture {
  dir: string;
  config: DatastoreConfig;
  resolver: DefaultDatastorePathResolver;
  repo: RepositoryContext;
  type: ModelType;
  executions: unknown[];
  fetcher: ForeignContentFetcher;
  fetched: Array<{ namespace: string; relPath: string }>;
}

async function removeDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}

function securityRow(dataName = "output"): CatalogRow {
  return {
    namespace: "security",
    type_normalized: "test/scanner",
    model_id: crypto.randomUUID(),
    data_name: dataName,
    id: crypto.randomUUID(),
    version: 1,
    is_latest: 1,
    is_step_latest: 1,
    model_name: "scanner",
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    garbage_collection: "10",
    lifecycle: "active",
    owner_type: "model-method",
    streaming: 0,
    size: 22,
    created_at: new Date().toISOString(),
    tags: JSON.stringify({
      type: "resource",
      modelName: "scanner",
      specName: "result",
    }),
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
  };
}

async function withForeignRecord(
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-3306-repo-" });
  const datastoreDir = await Deno.makeTempDir({ prefix: "swamp-3306-ds-" });
  const config: DatastoreConfig = { type: "filesystem", path: datastoreDir };
  const resolver = new DefaultDatastorePathResolver(dir, config);
  const fetched: Array<{ namespace: string; relPath: string }> = [];
  const fetcher: ForeignContentFetcher = (namespace, relPath) => {
    fetched.push({ namespace, relPath });
    return Promise.resolve(
      new TextEncoder().encode('{"content":"security"}'),
    );
  };
  const repo = createRepositoryContext({
    repoDir: dir,
    datastoreResolver: resolver,
    filterStaleRows: false,
    fetchForeignContent: fetcher,
  });
  const type = ModelType.create(`test/foreign-read-${crypto.randomUUID()}`);
  const executions: unknown[] = [];
  modelRegistry.register({
    type,
    version: "2026.10.12.1",
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
    // Populated before the foreign row arrives, so no backfill from disk
    // replaces it — the state a repository is in after a catalog pull.
    repo.catalogStore.markPopulated();
    repo.catalogStore.upsert(securityRow());
    await repo.definitionRepo.save(
      type,
      Definition.create({
        name: "consumer",
        methods: { run: { arguments: { value: FOREIGN_READ } } },
      }),
    );
    await fn({
      dir,
      config,
      resolver,
      repo,
      type,
      executions,
      fetcher,
      fetched,
    });
  } finally {
    modelRegistry.invalidateType(type);
    repo.catalogStore.close();
    await removeDir(dir);
    await removeDir(datastoreDir);
  }
}

Deno.test("foreign content: a model method run reads another namespace's attributes", async () => {
  await withForeignRecord(async ({ dir, repo, executions, fetched }) => {
    const deps = await createModelMethodRunDeps(dir, repo);
    const events = await collect(
      modelMethodRun(createLibSwampContext(), deps, {
        modelIdOrName: "consumer",
        methodName: "run",
        inputs: {},
        lastEvaluated: false,
      }),
    );
    assertEquals(events.filter((e) => e.kind === "error"), []);
    assertEquals(events.at(-1)?.kind, "completed");
    assertEquals(executions, [{ value: "security" }]);
    assertEquals(fetched.every((f) => f.namespace === "security"), true);
  });
});

Deno.test("foreign content: a workflow run reads another namespace's attributes", async () => {
  await withForeignRecord(async ({ dir, config, repo, executions }) => {
    const workflow = Workflow.create({
      name: "reads-security",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "capture",
          task: StepTask.model("consumer", "run", {}),
        })],
      })],
    });
    await repo.workflowRepo.save(workflow);

    const deps = await createWorkflowRunDeps(dir, repo, config);
    const service = deps.createExecutionService(
      repo.workflowRepo,
      repo.workflowRunRepo,
      dir,
      repo.catalogStore,
    );
    const run = await service.execute(workflow.name, {});

    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(executions, [{ value: "security" }]);
  });
});

Deno.test("foreign content: workflow evaluate saves another namespace's attribute", async () => {
  await withForeignRecord(async ({ dir, resolver, repo, fetcher }) => {
    repo.catalogStore.upsert(securityRow("second"));
    await repo.workflowRepo.save(Workflow.create({
      name: "reads-security",
      jobs: [Job.create({
        name: "main",
        // A step's own inputs are left for the run to resolve; forEach.in is
        // what evaluate reads data for.
        steps: [Step.create({
          name: "capture",
          forEach: {
            item: "content",
            in:
              '${{ data.query(\'ns == "security" && modelName == "scanner"\', "attributes.content") }}',
          },
          task: StepTask.model("consumer", "run", {
            value: "${{ self.content }}",
          }),
        })],
      })],
    }));

    const deps = createWorkflowEvaluateDeps(
      dir,
      repo.workflowRepo,
      resolver,
      undefined,
      undefined,
      fetcher,
    );
    const events = await collect<WorkflowEvaluateEvent>(
      workflowEvaluate(createLibSwampContext(), deps, {
        workflowIdOrName: "reads-security",
        inputs: {},
      }),
    );
    const completed = events.at(-1) as Extract<
      WorkflowEvaluateEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.kind, "completed", JSON.stringify(events));
    const saved = parseYaml(
      await Deno.readTextFile(
        (completed.data as { outputPath: string }).outputPath,
      ),
    ) as { jobs: { steps: { task: { inputs: Record<string, unknown> } }[] }[] };
    assertEquals(
      saved.jobs[0].steps.map((step) => step.task.inputs.value),
      ["security", "security"],
    );
  });
});

Deno.test("foreign content: model evaluate resolves another namespace's attribute only when handed the fetcher", async () => {
  await withForeignRecord(async ({ dir, resolver, repo, type, fetcher }) => {
    const found = await repo.definitionRepo.findByName(type, "consumer");
    const evaluate = async (given?: ForeignContentFetcher) => {
      const deps = createModelEvaluateDeps(
        dir,
        resolver,
        undefined,
        undefined,
        undefined,
        given,
      );
      const { definition } = await deps.evaluateDefinition(
        found!,
        type,
        new RunSensitiveValues(),
      );
      return definition.getMethodArguments("run").value;
    };

    assertEquals(await evaluate(fetcher), "security");
    assertEquals(await evaluate(), FOREIGN_READ);
  });
});
