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

import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import {
  getRemoteStepDispatcher,
  type RemoteStepRequest,
  setRemoteStepDispatcher,
} from "../src/domain/remote/remote_dispatch.ts";
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/data.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { DefaultStepExecutor } from "../src/domain/workflows/execution_service.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { YamlEvaluatedDefinitionRepository } from "../src/infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  createModelMethodRunDeps,
  createWorkflowRunDeps,
} from "../src/serve/deps.ts";
import {
  createLibSwampContext,
  createModelEvaluateDeps,
  createWorkflowEvaluateDeps,
  modelEvaluate,
  modelMethodRun,
  workflowEvaluate,
} from "../src/libswamp/mod.ts";
import { collect } from "../src/libswamp/testing.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

async function withRepo(
  fn: (
    repo: RepositoryContext,
    dir: string,
    type: ModelType,
    executions: unknown[],
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cache-provenance-" });
  const repo = createRepositoryContext({ repoDir: dir });
  const type = ModelType.create(`test/cache-${crypto.randomUUID()}`);
  const executions: unknown[] = [];
  modelRegistry.register({
    type,
    version: "2026.09.16.1",
    methods: {
      run: {
        description: "Capture resolved arguments in process",
        arguments: z.object({
          value: z.string(),
          authored: z.string().optional(),
        }),
        execute: (args) => {
          executions.push(args);
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  const originalToObject = Deno.env.toObject;
  Deno.env.toObject = () => ({
    HOME: "runtime-home",
    SOURCE: "runtime-source",
    INJECTED: "must-not-resolve",
    MODEL: "consumer",
    MODEL_TYPE: type.normalized,
    METHOD: "run",
    CHILD: "child",
    PARENT: "parent",
  });
  try {
    await fn(repo, dir, type, executions);
  } finally {
    Deno.env.toObject = originalToObject;
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

// Every invocation creates fresh repositories: provenance must survive on disk.
async function runModel(
  dir: string,
  inputs: Record<string, unknown> = {},
  lastEvaluated = false,
): Promise<void> {
  const repo = createRepositoryContext({ repoDir: dir });
  try {
    const deps = await createModelMethodRunDeps(dir, repo);
    const events = await collect(modelMethodRun(createLibSwampContext(), deps, {
      modelIdOrName: "consumer",
      methodName: "run",
      inputs,
      lastEvaluated,
    }));
    assertEquals(events.filter((e) => e.kind === "error"), []);
    assertEquals(events.at(-1)?.kind, "completed");
  } finally {
    repo.catalogStore.close();
  }
}

function inputDefinition(): Definition {
  return Definition.create({
    name: "consumer",
    inputs: { type: "object", properties: { value: { type: "string" } } },
    methods: {
      run: {
        arguments: {
          value: "${{ inputs.value }}",
          authored: "${{ env.SOURCE }}",
        },
      },
    },
  });
}

Deno.test("evaluated cache: optional input provenance survives a fresh model run", async () => {
  await withRepo(async (repo, dir, type, executions) => {
    const definition = inputDefinition();
    await repo.definitionRepo.save(type, definition);
    await runModel(dir, { value: "${{ env.HOME }}" });
    const cached = await repo.evaluatedDefinitionRepo.findByNameWithProvenance(
      type,
      definition.name,
    );
    assertExists(cached);
    assertEquals(
      cached.definition.getMethodArguments("run").value,
      "${{ env.HOME }}",
    );
    assertEquals(cached.authoredExpressions.has("${{ env.HOME }}"), true);
    await runModel(dir, {}, true);
    assertEquals(executions, [
      { value: "runtime-home", authored: "runtime-source" },
      { value: "runtime-home", authored: "runtime-source" },
    ]);
    assertEquals(
      (await repo.evaluatedDefinitionRepo.findByName(type, definition.name))
        ?.getMethodArguments("run").value,
      "${{ env.HOME }}",
    );
  });
});

Deno.test("evaluated cache: legacy caches authorize only source and current inputs", async () => {
  await withRepo(async (repo, dir, type, executions) => {
    const definition = inputDefinition();
    await repo.definitionRepo.save(type, definition);
    definition.setMethodArgument("run", "value", "${{ env.HOME }}");
    await repo.evaluatedDefinitionRepo.save(type, definition);
    await runModel(dir, {}, true);
    await runModel(dir, { value: "${{ env.HOME }}" }, true);
    assertEquals(executions, [
      { value: "${{ env.HOME }}", authored: "runtime-source" },
      { value: "runtime-home", authored: "runtime-source" },
    ]);
  });
});

Deno.test("evaluated cache: substituted data stays literal through run and standalone evaluation", async () => {
  await withRepo(async (repo, dir, type, executions) => {
    const producer = Definition.create({ name: "producer" });
    await repo.definitionRepo.save(type, producer);
    const data = Data.create({
      name: "notes",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "state", modelName: producer.name },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${type.normalized}:${producer.id}`,
      },
    });
    await repo.unifiedDataRepo.save(
      type,
      producer.id,
      data,
      new TextEncoder().encode(
        JSON.stringify({ value: "${{ env.INJECTED }}" }),
      ),
    );
    const definition = Definition.create({
      name: "consumer",
      methods: {
        run: {
          arguments: {
            value: '${{ data.latest("producer", "notes").attributes.value }}',
            authored: '${{ env["HOME"] }}',
          },
        },
      },
    });
    await repo.definitionRepo.save(type, definition);
    await runModel(dir);
    await runModel(dir, {}, true);
    // Both single-model and batch evaluation must persist source provenance.
    const deps = createModelEvaluateDeps(
      dir,
      undefined,
      repo.unifiedDataRepo,
      repo.catalogStore,
      repo.definitionRepo,
    );
    for (const modelIdOrName of [definition.name, undefined]) {
      const events = await collect(
        modelEvaluate(createLibSwampContext(), deps, { modelIdOrName }),
      );
      assertEquals(events.filter((e) => e.kind === "error"), []);
      const cached = await new YamlEvaluatedDefinitionRepository(dir)
        .findByNameWithProvenance(type, definition.name);
      assertExists(cached);
      assertEquals(
        cached.definition.getMethodArguments("run").value,
        "${{ env.INJECTED }}",
      );
      assertEquals(
        cached.definition.getMethodArguments("run").authored,
        '${{ env["HOME"] }}',
      );
      assertEquals(
        cached.authoredExpressions.has("${{ env.INJECTED }}"),
        false,
      );
      assertEquals(cached.authoredExpressions.has('${{ env["HOME"] }}'), true);
      await runModel(dir, {}, true);
    }
    assertEquals(
      executions,
      Array.from(
        { length: 4 },
        () => ({ value: "${{ env.INJECTED }}", authored: "runtime-home" }),
      ),
    );
  });
});

Deno.test("evaluated cache: workflow steps retain saved provenance without authorizing substituted inputs", async () => {
  await withRepo(async (repo, dir, type, executions) => {
    const definition = inputDefinition();
    await repo.definitionRepo.save(type, definition);
    const context = {
      workflowId: createWorkflowId(crypto.randomUUID()),
      workflowRunId: crypto.randomUUID(),
      workflowName: "cache-test",
      jobName: "main",
      stepName: "capture",
      repoDir: dir,
      signal: new AbortController().signal,
      catalogStore: repo.catalogStore,
      expressionContext: { model: {}, env: {}, inputs: {} },
    };
    const step = Step.create({
      name: "capture",
      task: StepTask.modelMethod(definition.name, "run", {
        value: "${{ env.HOME }}",
        authored: "${{ env.INJECTED }}",
      }),
    });
    // The evaluated step contains substituted text; only HOME was authored.
    await new DefaultStepExecutor().execute(step, {
      ...context,
      authoredExpressions: new Set(["${{ env.HOME }}"]),
    });
    const cached = await new YamlEvaluatedDefinitionRepository(dir)
      .findByNameWithProvenance(type, definition.name);
    assertExists(cached);
    assertEquals(cached.authoredExpressions.has("${{ env.HOME }}"), true);
    assertEquals(cached.authoredExpressions.has("${{ env.INJECTED }}"), false);
    await new DefaultStepExecutor().execute(
      Step.create({
        name: "capture",
        task: StepTask.modelMethod(definition.name, "run"),
      }),
      {
        ...context,
        expressionContext: { model: {}, env: {} },
        mode: "lastEvaluated",
        authoredExpressions: new Set(),
      },
    );
    assertEquals(executions, [
      { value: "runtime-home", authored: "${{ env.INJECTED }}" },
      { value: "runtime-home", authored: "${{ env.INJECTED }}" },
    ]);
  });
});

// Bracket-index env access was evaluated in the persist phase before env
// detection became CEL-aware; now it is deferred, so the runtime pass must
// still see every namespace the expression reads.
Deno.test("evaluated cache: deferred env expressions keep the model and data namespaces on standalone runs", async () => {
  await withRepo(async (repo, dir, type, executions) => {
    const producer = Definition.create({ name: "producer" });
    await repo.definitionRepo.save(type, producer);
    const data = Data.create({
      name: "notes",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "state", modelName: producer.name },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${type.normalized}:${producer.id}`,
      },
    });
    await repo.unifiedDataRepo.save(
      type,
      producer.id,
      data,
      new TextEncoder().encode(JSON.stringify({ note: "from-data" })),
    );
    const definition = Definition.create({
      name: "consumer",
      methods: {
        run: {
          arguments: {
            value: "${{ env['HOME'] + ':' + model.producer.input.name }}",
            authored:
              '${{ env["SOURCE"] + ":" + data.latest("producer", "notes").attributes.note }}',
          },
        },
      },
    });
    await repo.definitionRepo.save(type, definition);
    await runModel(dir);
    await runModel(dir, {}, true);
    assertEquals(executions, [
      { value: "runtime-home:producer", authored: "runtime-source:from-data" },
      { value: "runtime-home:producer", authored: "runtime-source:from-data" },
    ]);
  });
});

function workflowWithTask(name: string, task: StepTask): Workflow {
  return Workflow.create({
    name,
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({ name: "capture", task })],
    })],
  });
}

async function runWorkflow(
  repo: RepositoryContext,
  dir: string,
  name: string,
  lastEvaluated = false,
  inputs: Record<string, unknown> = {},
) {
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
  return await service.execute(name, { lastEvaluated, inputs });
}

for (const direct of [false, true]) {
  Deno.test(`workflow runtime selectors: resolves ${direct ? "direct-type" : "stored model"} selectors without caching values`, async () => {
    await withRepo(async (repo, dir, type, executions) => {
      if (!direct) {
        await repo.definitionRepo.save(
          type,
          Definition.create({ name: "consumer" }),
        );
      }
      const task = direct
        ? StepTask.directExecution(
          '${{ env["MODEL_TYPE"] }}',
          '${{ env["MODEL"] }}',
          '${{ env["METHOD"] }}',
          { value: '${{ env["HOME"] }}' },
        )
        : StepTask.model('${{ env["MODEL"] }}', '${{ env["METHOD"] }}', {
          value: '${{ env["HOME"] }}',
        });
      const workflow = workflowWithTask("selectors", task);
      await repo.workflowRepo.save(workflow);
      for (const lastEvaluated of [false, true]) {
        const run = await runWorkflow(repo, dir, workflow.name, lastEvaluated);
        assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
        const cached = await new YamlEvaluatedWorkflowRepository(dir)
          .findByNameWithProvenance(workflow.name);
        assertExists(cached);
        assertEquals(
          JSON.parse(
            JSON.stringify(cached.workflow.jobs[0].steps[0].task.data),
          ),
          JSON.parse(JSON.stringify(task.data)),
        );
        assertEquals(
          (await repo.evaluatedDefinitionRepo.findByName(type, "consumer"))
            ?.getMethodArguments("run").value,
          '${{ env["HOME"] }}',
        );
      }
      assertEquals(executions, [{ value: "runtime-home" }, {
        value: "runtime-home",
      }]);
      assertEquals(workflow.jobs[0].steps[0].task.data, task.data);
    });
  });
}

Deno.test("workflow runtime selectors: resolves nested target before lookup and cycle detection", async () => {
  await withRepo(async (repo, dir, type, executions) => {
    await repo.definitionRepo.save(
      type,
      Definition.create({ name: "consumer" }),
    );
    const child = workflowWithTask(
      "child",
      StepTask.model("consumer", "run", { value: "nested" }),
    );
    await repo.workflowRepo.save(child);
    const parent = workflowWithTask(
      "parent",
      StepTask.workflow('${{ env["CHILD"] }}'),
    );
    await repo.workflowRepo.save(parent);
    assertEquals(
      (await runWorkflow(repo, dir, parent.name)).status,
      "succeeded",
    );
    assertEquals(executions, [{ value: "nested" }]);
    const cached = await new YamlEvaluatedWorkflowRepository(dir)
      .findByNameWithProvenance(parent.name);
    assertEquals(
      JSON.stringify(cached?.workflow.jobs[0].steps[0].task.data),
      JSON.stringify(parent.jobs[0].steps[0].task.data),
    );

    // The child now refers back to the parent through an env selector.
    await repo.workflowRepo.save(Workflow.fromData({
      ...child.toData(),
      jobs: workflowWithTask("child", StepTask.workflow('${{ env["PARENT"] }}'))
        .toData().jobs,
    }));
    const run = await runWorkflow(repo, dir, parent.name);
    assertEquals(run.status, "failed");
    const childRun = await repo.workflowRunRepo.findLatestByWorkflowId(
      child.id,
    );
    assertStringIncludes(
      childRun?.getJob("main")?.getStep("capture")?.error ?? "",
      "Workflow cycle detected",
    );
  });
});

for (const selector of ["model", "type", "name", "method", "workflow"]) {
  Deno.test(`workflow runtime selectors: substituted ${selector} expression stays unauthorized on replay`, async () => {
    await withRepo(async (repo, dir, type, executions) => {
      await repo.definitionRepo.save(
        type,
        Definition.create({ name: "consumer" }),
      );
      await repo.workflowRepo.save(
        workflowWithTask(
          "child",
          StepTask.model("consumer", "run", { value: "injected" }),
        ),
      );
      const injectedSelector = "${{ inputs.selector }}";
      const task = selector === "workflow"
        ? StepTask.workflow(injectedSelector)
        : selector === "type" || selector === "name"
        ? StepTask.directExecution(
          selector === "type" ? injectedSelector : type.normalized,
          selector === "name" ? injectedSelector : "consumer",
          "run",
          { value: "injected" },
        )
        : StepTask.model(
          selector === "model" ? injectedSelector : "consumer",
          selector === "method" ? injectedSelector : "run",
          { value: "injected" },
        );
      const expression = '${{ env["' +
        ({
          model: "MODEL",
          type: "MODEL_TYPE",
          name: "MODEL",
          method: "METHOD",
          workflow: "CHILD",
        }[selector]) + '"] }}';
      const workflow = workflowWithTask("substituted-selector", task);
      await repo.workflowRepo.save(workflow);
      for (const lastEvaluated of [false, true]) {
        const run = await runWorkflow(repo, dir, workflow.name, lastEvaluated, {
          selector: expression,
        });
        assertEquals(run.status, "failed");
        const cached = await new YamlEvaluatedWorkflowRepository(dir)
          .findByNameWithProvenance(workflow.name);
        assertExists(cached);
        assertEquals(cached.authoredExpressions.has(expression), false);
      }
      assertEquals(executions, []);
    });
  });
}

for (const location of ["workflow", "definition", "file", "direct"]) {
  Deno.test(`workflow cached context: deferred env with ${location} dependencies survives replay and source edits`, async () => {
    await withRepo(async (repo, dir, type, executions) => {
      const producer = Definition.create({
        name: "producer",
        globalArguments: { prefix: ":source" },
      });
      await repo.definitionRepo.save(type, producer);
      const expression = location === "file"
        ? '${{ env.HOME + (file.contents("producer", "missing") == null ? ":no-file" : ":file") }}'
        : '${{ env["HOME"] + model.producer.input.globalArguments.prefix }}';
      const consumer = Definition.create({
        name: "consumer",
        methods: {
          run: {
            arguments: {
              value: location === "workflow" ? "default" : expression,
            },
          },
        },
      });
      await repo.definitionRepo.save(type, consumer);
      const inputs = {
        ...(location === "workflow" ? { value: expression } : {}),
        authored: '${{ env["SOURCE"] + inputs.suffix }}',
      };
      const workflow = workflowWithTask(
        "cached-context",
        location === "direct"
          ? StepTask.directExecution(
            type.normalized,
            "consumer",
            "run",
            inputs,
            {
              // This resolves during evaluation, leaving only the cached
              // definition's deferred expression to require model on replay.
              prefix: "${{ model.producer.input.globalArguments.prefix }}",
            },
          )
          : StepTask.model("consumer", "run", inputs),
      );
      await repo.workflowRepo.save(workflow);
      const fresh = await runWorkflow(repo, dir, workflow.name, false, {
        suffix: ":fresh",
      });
      assertEquals(fresh.status, "succeeded", JSON.stringify(fresh.toData()));

      // The cache still requires model/file even after the source stops doing so.
      consumer.setMethodArgument("run", "value", "edited-source");
      await repo.definitionRepo.save(type, consumer);
      await repo.workflowRepo.save(
        Workflow.fromData({
          ...workflow.toData(),
          jobs: workflowWithTask(
            "cached-context",
            StepTask.model("consumer", "run"),
          ).toData().jobs,
        }),
      );
      // The namespace must come from current model sources, not evaluated caches.
      await repo.evaluatedDefinitionRepo.save(
        type,
        Definition.create({
          name: "producer",
          globalArguments: { prefix: ":wrong-cache" },
        }),
      );
      const replay = await runWorkflow(repo, dir, workflow.name, true, {
        suffix: ":replay",
      });
      assertEquals(replay.status, "succeeded", JSON.stringify(replay.toData()));
      const value = location === "file"
        ? "runtime-home:no-file"
        : "runtime-home:source";
      assertEquals(executions, [
        { value, authored: "runtime-source:fresh" },
        { value, authored: "runtime-source:replay" },
      ]);
    });
  });
}

for (const depth of [1, 2]) {
  for (const childSuffix of [undefined, ":child"]) {
    Deno.test(`nested runtime scope: depth ${depth}, child suffix ${childSuffix}, fresh/resume/cache`, async () => {
      await withRepo(async (repo, dir, type, executions) => {
        await repo.definitionRepo.save(
          type,
          Definition.create({ name: "consumer" }),
        );
        const expression = "${{ env['HOME'] + inputs.suffix }}";
        const child = Workflow.create({
          name: "child",
          jobs: [Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "capture",
                task: StepTask.model("consumer", "run", {
                  value: "${{ inputs.value }}",
                  ...(childSuffix ? { authored: expression } : {}),
                }),
              }),
              // Leave a failed run so direct resume can replay the capture step.
              Step.create({
                name: "fail",
                task: StepTask.model("missing", "run"),
              }),
            ],
          })],
        });
        await repo.workflowRepo.save(child);
        if (depth === 2) {
          await repo.workflowRepo.save(
            workflowWithTask(
              "middle",
              StepTask.workflow("child", {
                value: "${{ inputs.value }}",
                ...(childSuffix ? { suffix: childSuffix } : {}),
              }),
            ),
          );
        }
        await repo.workflowRepo.save(
          workflowWithTask(
            "parent",
            StepTask.workflow(depth === 2 ? "middle" : "child", {
              value: expression,
              ...(childSuffix ? { suffix: childSuffix } : {}),
            }),
          ),
        );
        const expected = {
          value: "runtime-home:parent",
          ...(childSuffix ? { authored: "runtime-home:child" } : {}),
        };
        const parent = await runWorkflow(repo, dir, "parent", false, {
          suffix: ":parent",
        });
        assertEquals(parent.status, "failed");
        assertEquals(executions, [expected]);
        const childRun = await repo.workflowRunRepo.findLatestByWorkflowId(
          child.id,
        );
        assertExists(childRun);
        assertEquals(childRun.deferredExpressions.length, 1);
        assertEquals(
          childRun.deferredExpressions[0].bindings.inputs?.suffix,
          ":parent",
        );
        assertEquals(
          childRun.deferredExpressions[0].bindings.run?.id,
          parent.id,
        );

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
        const resumed = await collect(
          service.resume(child.name, childRun.id, { fromStep: "capture" }),
        );
        assertEquals(resumed.at(-1)?.kind, "completed");
        assertEquals(executions, [expected, expected]);
        // Cached workflow and model reload their own records, even with different caller inputs.
        await runWorkflow(repo, dir, child.name, true, {
          suffix: ":child",
          value: "changed",
        });
        assertEquals(executions, [expected, expected, expected]);
        if (!childSuffix) {
          await runModel(dir, {}, true);
          assertEquals(
            (executions.at(-1) as { value: string }).value,
            expected.value,
          );
        }

        const cachedWorkflow = await new YamlEvaluatedWorkflowRepository(dir)
          .findByNameWithProvenance(child.name);
        const cachedDefinition = await repo.evaluatedDefinitionRepo
          .findByNameWithProvenance(type, "consumer");
        for (
          const metadata of [
            childRun.toData(),
            cachedWorkflow,
            cachedDefinition,
          ]
        ) {
          const text = JSON.stringify(metadata);
          assertEquals(text.includes("runtime-home"), false);
          assertEquals(text.includes('"env":'), false);
          assertEquals(
            JSON.stringify(metadata?.deferredExpressions).includes('"model":'),
            false,
          );
        }
      });
    });
  }
}

// A direct-type step persists its global arguments into an auto-created
// definition. A parent-passed expression that reads no parent scope is
// stored as its authored text, exactly as before deferral; one that does
// read parent scope is refused instead of being stored as a dangling token.
Deno.test("nested runtime scope: direct-type global arguments restore unscoped parent expressions and refuse scoped ones", async () => {
  await withRepo(async (repo, dir, _type, _executions) => {
    const direct = ModelType.create(`test/direct-${crypto.randomUUID()}`);
    const globals: unknown[] = [];
    modelRegistry.register({
      type: direct,
      version: "2026.09.16.1",
      globalArguments: z.object({ home: z.string() }),
      methods: {
        run: {
          description: "Capture resolved global arguments in process",
          arguments: z.object({}),
          execute: (_args, context) => {
            globals.push(context.globalArgs);
            return Promise.resolve({ dataHandles: [] });
          },
        },
      },
    });
    await repo.workflowRepo.save(
      workflowWithTask(
        "direct-child",
        StepTask.directExecution(direct.normalized, "auto-home", "run", {
          home: "${{ inputs.home }}",
        }),
      ),
    );
    await repo.workflowRepo.save(
      workflowWithTask(
        "unscoped-parent",
        StepTask.workflow("direct-child", { home: "${{ env.HOME }}" }),
      ),
    );
    await repo.workflowRepo.save(
      workflowWithTask(
        "scoped-parent",
        StepTask.workflow("direct-child", {
          home: "${{ env.HOME + inputs.suffix }}",
        }),
      ),
    );

    const unscoped = await runWorkflow(repo, dir, "unscoped-parent");
    assertEquals(
      unscoped.status,
      "succeeded",
      JSON.stringify(unscoped.toData()),
    );
    assertEquals(globals, [{ home: "runtime-home" }]);
    const stored = await repo.definitionRepo.findByNameGlobal("auto-home");
    assertExists(stored);
    assertEquals(stored.definition.globalArguments, {
      home: "${{ env.HOME }}",
    });
    // The stored definition still works on its own and accepts a literal.
    const standalone = await runWorkflow(repo, dir, "direct-child", false, {
      home: "literal-home",
    });
    assertEquals(standalone.status, "succeeded");
    assertEquals(globals, [{ home: "runtime-home" }, { home: "literal-home" }]);

    const scoped = await runWorkflow(repo, dir, "scoped-parent", false, {
      suffix: ":parent",
    });
    assertEquals(scoped.status, "failed");
    assertStringIncludes(
      JSON.stringify(scoped.toData()),
      "scoped to the calling workflow run",
    );
    assertEquals(globals.length, 2);
    assertEquals(
      (await repo.definitionRepo.findByNameGlobal("auto-home"))?.definition
        .globalArguments,
      { home: "literal-home" },
    );
  });
});

Deno.test("nested runtime scope: dynamic vault arguments survive persistence without secrets", async () => {
  await withRepo(async (repo, dir, type, executions) => {
    await repo.vaultConfigRepo.save(
      VaultConfig.create(
        crypto.randomUUID(),
        "parent-vault",
        "local_encryption",
        { auto_generate: true },
      ),
    );
    const vault = await VaultService.fromRepository(dir);
    const secret = `secret-${crypto.randomUUID()}`;
    await vault.put("parent-vault", "parent-key", secret);
    await repo.definitionRepo.save(
      type,
      Definition.create({ name: "consumer" }),
    );
    const expression =
      "${{ vault.get(inputs.vault, inputs.key) + inputs.suffix }}";
    const child = workflowWithTask(
      "child",
      StepTask.model("consumer", "run", { value: "${{ inputs.value }}" }),
    );
    const childData = child.toData();
    childData.jobs[0].steps.push(
      Step.create({ name: "fail", task: StepTask.model("missing", "run") })
        .toData(),
    );
    await repo.workflowRepo.save(Workflow.fromData(childData));
    await repo.workflowRepo.save(
      workflowWithTask(
        "parent",
        StepTask.workflow("child", { value: expression }),
      ),
    );
    const parent = await runWorkflow(repo, dir, "parent", false, {
      vault: "parent-vault",
      key: "parent-key",
      suffix: ":parent",
    });
    assertEquals(parent.status, "failed", JSON.stringify(parent.toData()));
    const childRun = await repo.workflowRunRepo.findLatestByWorkflowId(
      child.id,
    );
    assertExists(childRun);
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
    await collect(
      service.resume(child.name, childRun.id, { fromStep: "capture" }),
    );
    await runWorkflow(repo, dir, "child", true, {
      vault: "missing",
      key: "wrong",
      suffix: ":child",
    });
    await runModel(dir, {}, true);
    assertEquals(
      executions,
      Array.from({ length: 4 }, () => ({ value: secret + ":parent" })),
    );
    const cachedWorkflow = await new YamlEvaluatedWorkflowRepository(dir)
      .findByNameWithProvenance(child.name);
    const cachedModel = await repo.evaluatedDefinitionRepo
      .findByNameWithProvenance(type, "consumer");
    for (
      const data of [
        parent.toData(),
        childRun.toData(),
        cachedWorkflow,
        cachedModel,
      ]
    ) {
      assertEquals(JSON.stringify(data).includes(secret), false);
      assertEquals(JSON.stringify(data).includes("__SWAMP_VSEC_"), false);
    }
  });
});

Deno.test("assert: a vault secret in the failure message is redacted before persistence and events", async () => {
  await withRepo(async (repo, dir) => {
    await repo.vaultConfigRepo.save(
      VaultConfig.create(
        crypto.randomUUID(),
        "assert-vault",
        "local_encryption",
        { auto_generate: true },
      ),
    );
    const vault = await VaultService.fromRepository(dir);
    const secret = `secret-${crypto.randomUUID()}`;
    await vault.put("assert-vault", "assert-key", secret);
    const workflow = workflowWithTask(
      "assert-secret",
      StepTask.assert(
        "false",
        "token=${{ vault.get('assert-vault', 'assert-key') }}",
        "high",
      ),
    );
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
    const events = await collect(service.run(workflow.name));
    const run = await repo.workflowRunRepo.findLatestByWorkflowId(workflow.id);
    assertExists(run);
    assertEquals(run.status, "failed");
    const assertEvent = events.find((e) => e.kind === "assert_result");
    assertExists(assertEvent);
    // The message reached the failing path with the secret substituted...
    assertStringIncludes(assertEvent.message, "token=");
    assertEquals(assertEvent.message.includes("vault.get"), false);
    // ...but neither the events nor the run record carry it in plaintext.
    for (const data of [events, run.toData()]) {
      assertEquals(JSON.stringify(data).includes(secret), false);
    }
  });
});

Deno.test("nested runtime scope: cached deferred records do not grow across --last-evaluated replays", async () => {
  await withRepo(async (repo, dir, type, executions) => {
    await repo.definitionRepo.save(
      type,
      Definition.create({ name: "consumer" }),
    );
    const child = workflowWithTask(
      "child",
      StepTask.model("consumer", "run", { value: "${{ inputs.value }}" }),
    );
    await repo.workflowRepo.save(child);
    await repo.workflowRepo.save(
      workflowWithTask(
        "parent",
        StepTask.workflow("child", { value: '${{ env["HOME"] }}' }),
      ),
    );
    const parent = await runWorkflow(repo, dir, "parent");
    assertEquals(parent.status, "succeeded", JSON.stringify(parent.toData()));
    const first = await repo.evaluatedDefinitionRepo
      .findByNameWithProvenance(type, "consumer");
    assertExists(first);
    const ids = first.deferredExpressions.map((record) => record.id);
    assertEquals(ids.length, 1);
    for (let i = 0; i < 2; i++) {
      const run = await runWorkflow(repo, dir, "child", true);
      assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
      const cached = await repo.evaluatedDefinitionRepo
        .findByNameWithProvenance(type, "consumer");
      assertExists(cached);
      assertEquals(cached.deferredExpressions.map((r) => r.id), ids);
    }
    assertEquals(
      executions,
      Array.from({ length: 3 }, () => ({ value: "runtime-home" })),
    );
  });
});

for (const level of ["workflow", "job", "step"]) {
  Deno.test(`runtime placement: ${level} inheritance resolves before dispatch`, async () => {
    await withRepo(async (repo, dir, type) => {
      await repo.definitionRepo.save(
        type,
        Definition.create({ name: "consumer" }),
      );
      const placement = {
        target: "${{ env.HOME + inputs.suffix }}",
        labels: { region: "${{ env.SOURCE }}" },
        platform: "${{ env.METHOD }}",
      };
      const workflow = Workflow.create({
        name: "placement",
        ...(level === "workflow"
          ? placement
          : { target: "overridden-workflow" }),
        jobs: [Job.create({
          name: "main",
          ...(level === "job"
            ? placement
            : level === "step"
            ? { target: "overridden-job" }
            : {}),
          steps: [Step.create({
            name: "capture",
            ...(level === "step" ? placement : {}),
            task: StepTask.model("consumer", "run", { value: "placed" }),
          })],
        })],
      });
      await repo.workflowRepo.save(workflow);
      const requests: RemoteStepRequest[] = [];
      const original = getRemoteStepDispatcher();
      setRemoteStepDispatcher({
        executeRemote: (request) => {
          requests.push(request);
          return Promise.resolve({ outputs: [], logs: [], durationMs: 0 });
        },
        releaseAffinity() {},
      });
      try {
        for (const lastEvaluated of [false, true]) {
          const run = await runWorkflow(
            repo,
            dir,
            workflow.name,
            lastEvaluated,
            { suffix: ":placed" },
          );
          assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
        }
        assertEquals(requests.length, 2);
        for (const request of requests) {
          assertEquals(request.placement.target, "runtime-home:placed");
          assertEquals(request.placement.labels, { region: "runtime-source" });
          assertEquals(request.placement.platform, "run");
        }
      } finally {
        setRemoteStepDispatcher(original);
      }
    });
  });
}

for (const via of ["inputs", "data", "forEach"]) {
  Deno.test(`provenance guards: ordinary, runtime and record CEL injected through ${via}`, async () => {
    await withRepo(async (repo, dir, type, executions) => {
      await repo.definitionRepo.save(
        type,
        Definition.create({ name: "consumer" }),
      );
      const injected = {
        ordinary: "${{ 40 + 2 }}",
        runtime: "${{ env.HOME }}",
        record: '${{ {"value": "executed"} }}',
      };
      if (via === "data") {
        const data = Data.create({
          name: "payload",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "state", modelName: "consumer" },
          ownerDefinition: {
            ownerType: "model-method",
            ownerRef: `${type.normalized}:consumer`,
          },
        });
        await repo.unifiedDataRepo.save(
          type,
          (await repo.definitionRepo.findByName(type, "consumer"))!.id,
          data,
          new TextEncoder().encode(JSON.stringify(injected)),
        );
      }
      const reference = via === "inputs"
        ? "inputs.payload"
        : via === "forEach"
        ? "self.item"
        : "data.latest('consumer', 'payload').attributes";
      const steps = Object.keys(injected).map((key) =>
        Step.create({
          name: key,
          ...(via === "forEach"
            ? { forEach: { item: "item", in: "${{ inputs.items }}" } }
            : {}),
          task: StepTask.model("consumer", "run", {
            value: "${{ " + reference + "." + key + " }}",
          }),
        })
      );
      steps.push(Step.create({
        name: "message",
        ...(via === "forEach"
          ? { forEach: { item: "item", in: "${{ inputs.items }}" } }
          : {}),
        task: StepTask.assert("true", "${{ " + reference + ".ordinary }}"),
      }));
      await repo.workflowRepo.save(
        Workflow.create({
          name: "injection",
          jobs: [Job.create({ name: "main", steps })],
        }),
      );
      const run = await runWorkflow(repo, dir, "injection", false, {
        payload: injected,
        items: [injected],
      });
      assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
      assertEquals(
        executions.map((value) => (value as { value: string }).value).sort(),
        Object.values(injected).sort(),
      );

      assertEquals(
        run.getJob("main")?.getStep(via === "forEach" ? "message-0" : "message")
          ?.assertResult?.message,
        injected.ordinary,
      );

      // A record-only field must reject substituted expression text before CEL runs.
      await repo.workflowRepo.save(
        Workflow.create({
          name: "record-injection",
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "capture",
              ...(via === "forEach"
                ? { forEach: { item: "item", in: "${{ inputs.items }}" } }
                : {}),
              task: StepTask.fromData({
                type: "model_method",
                modelIdOrName: "consumer",
                methodName: "run",
                inputs: "${{ " + reference + ".record }}",
              }),
            })],
          })],
        }),
      );
      const rejected = await runWorkflow(repo, dir, "record-injection", false, {
        payload: injected,
        items: [injected],
      });
      assertEquals(rejected.status, "failed");
      assertStringIncludes(
        rejected.getJob("main")?.getStep(
          via === "forEach" ? "capture-0" : "capture",
        )?.error ?? "",
        via === "data" ? "expected a record" : "authored record expression",
      );
      assertEquals(executions.length, 3);
    });
  });
}

for (const mode of ["run", "evaluate", "array", "object"]) {
  Deno.test(`assert provenance: ${mode} preserves raw CEL through cache replay`, async () => {
    await withRepo(async (repo, dir) => {
      const expands = mode === "array" || mode === "object";
      const predicate = 'size("${{ inputs.value }}") > 0 && ' +
        'size("${{ self.item }}") > 0 && size("${{ missing.value }}") > 0';
      const workflow = Workflow.create({
        name: "assert-literals",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "verify",
            ...(expands
              ? {
                forEach: {
                  item: "item",
                  in: mode === "array"
                    ? '${{ ["first", "second"] }}'
                    : '${{ {"first": 1, "second": 2} }}',
                },
              }
              : {}),
            task: StepTask.assert(
              predicate,
              "Value: ${{ inputs.value }}" +
                (expands ? " Item: ${{ self.item }}" : ""),
            ),
          })],
        })],
      });
      await repo.workflowRepo.save(workflow);
      const inputs = { value: "resolved" };
      if (mode === "run") {
        const fresh = await runWorkflow(
          repo,
          dir,
          workflow.name,
          false,
          inputs,
        );
        assertEquals(fresh.status, "succeeded", JSON.stringify(fresh.toData()));
      } else {
        const events = await collect(workflowEvaluate(
          createLibSwampContext(),
          createWorkflowEvaluateDeps(dir, repo.workflowRepo),
          { workflowIdOrName: workflow.name, inputs },
        ));
        assertEquals(events.at(-1)?.kind, "completed");
      }
      const cacheRepo = new YamlEvaluatedWorkflowRepository(dir);
      const cached = await cacheRepo.findByNameWithProvenance(workflow.name);
      assertExists(cached);
      assertEquals(cached.authoredExpressions.has(predicate), true);
      assertEquals(
        cached.authoredExpressions.has("${{ missing.value }}"),
        false,
      );
      assertEquals(cached.workflow.jobs[0].steps.length, expands ? 2 : 1);
      // Replay must use cache provenance even after the source predicate changes.
      await repo.workflowRepo.save(Workflow.fromData({
        ...workflow.toData(),
        jobs:
          workflowWithTask(workflow.name, StepTask.assert("false", "edited"))
            .toData().jobs,
      }));
      const replay = await runWorkflow(repo, dir, workflow.name, true);
      assertEquals(replay.status, "succeeded", JSON.stringify(replay.toData()));
      for (const step of replay.getJob("main")!.steps) {
        assertEquals(step.assertResult?.expr, predicate);
        assertEquals(step.assertResult?.passed, true);
        assertStringIncludes(
          step.assertResult?.message ?? "",
          "Value: resolved",
        );
      }
    });
  });
}

Deno.test("assert provenance: substituted messages stay literal and predicates cannot become CEL", async () => {
  await withRepo(async (repo, dir) => {
    for (const injected of ["${{ 40 + 2 }}", "${{ env.HOME }}"]) {
      const workflow = workflowWithTask(
        "assert-message",
        StepTask.assert("true", "${{ inputs.message }}"),
      );
      await repo.workflowRepo.save(workflow);
      for (const cached of [false, true]) {
        const run = await runWorkflow(repo, dir, workflow.name, cached, {
          message: injected,
        });
        assertEquals(
          run.getJob("main")?.getStep("capture")?.assertResult?.message,
          injected,
        );
      }
    }
    await repo.workflowRepo.save(
      workflowWithTask(
        "assert-predicate",
        StepTask.assert("${{ inputs.predicate }}", "predicate"),
      ),
    );
    const rejected = await runWorkflow(repo, dir, "assert-predicate", false, {
      predicate: "true",
    });
    assertEquals(rejected.status, "failed");
    assertEquals(
      rejected.getJob("main")?.getStep("capture")?.assertResult?.expr,
      "${{ inputs.predicate }}",
    );
    // A substituted predicate in a cache must still fail the provenance gate.
    const cacheRepo = new YamlEvaluatedWorkflowRepository(dir);
    const cached = await cacheRepo.findByNameWithProvenance("assert-predicate");
    assertExists(cached);
    await cacheRepo.save(
      Workflow.fromData({
        ...cached.workflow.toData(),
        jobs: workflowWithTask(
          "assert-predicate",
          StepTask.assert("true", "injected"),
        )
          .toData().jobs,
      }),
      cached.authoredExpressions,
    );
    const substituted = await runWorkflow(repo, dir, "assert-predicate", true);
    assertEquals(substituted.status, "failed");
    assertStringIncludes(
      substituted.getJob("main")?.getStep("capture")?.assertResult?.error ?? "",
      "authored CEL source",
    );
    await repo.workflowRepo.save(
      workflowWithTask(
        "assert-authored",
        StepTask.assert("inputs.ok", "Home: ${{ env.HOME }}"),
      ),
    );
    const authored = await runWorkflow(repo, dir, "assert-authored", false, {
      ok: true,
    });
    assertEquals(authored.status, "succeeded");
    assertEquals(
      authored.getJob("main")?.getStep("capture")?.assertResult?.message,
      "Home: runtime-home",
    );
  });
});

Deno.test("nested runtime scope: rebuilds model services and retains parent self/run/steps", async () => {
  await withRepo(async (repo, dir, type, executions) => {
    await repo.definitionRepo.save(
      type,
      Definition.create({ name: "consumer" }),
    );
    await repo.workflowRepo.save(
      workflowWithTask(
        "child",
        StepTask.model("consumer", "run", { value: "${{ inputs.value }}" }),
      ),
    );
    const parent = Workflow.create({
      name: "parent",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "ready",
            task: StepTask.assert("true", "ready"),
          }),
          Step.create({
            name: "call",
            dependsOn: [{
              step: "ready",
              condition: TriggerCondition.succeeded(),
            }],
            forEach: { item: "item", in: "${{ inputs.items }}" },
            task: StepTask.workflow("child", {
              value:
                "${{ env.HOME + inputs.suffix + self.item.suffix + ':' + run.workflowName + ':' + workflowRunId + ':' + steps.ready.status + ':' + model.consumer.input.name }}",
            }),
          }),
        ],
      })],
    });
    await repo.workflowRepo.save(parent);
    const run = await runWorkflow(repo, dir, parent.name, false, {
      suffix: ":parent",
      items: [{ suffix: ":iteration" }],
    });
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    const expected = {
      value:
        `runtime-home:parent:iteration:parent:${run.id}:succeeded:consumer`,
    };
    assertEquals(executions, [expected]);
    await runWorkflow(repo, dir, "child", true);
    assertEquals(executions, [expected, expected]);
  });
});
