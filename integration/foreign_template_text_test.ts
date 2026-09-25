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

// Integration test for swamp-club#2491: the definition pass and the run-time
// guard on global arguments share one judgement of which `${{ ... }}` text is
// swamp's. The definition pass leaves another templating system's text raw;
// the guard must then hand it to the method, while still refusing swamp
// expressions that failed or that it cannot parse.
//
// It also covers swamp-club#2496: a workflow step that runs a model type
// directly validates the definition it builds from its evaluated arguments,
// so the template-syntax scan must read the step's authored arguments, or
// text that evaluation produced reads as a swamp expression missing its `$`.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";

import { DefinitionExpressionEvaluator } from "../src/domain/workflows/expression_evaluators.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { buildMethodContext } from "../src/domain/models/method_context.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { MethodDefinition } from "../src/domain/models/model.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import { collect } from "../src/libswamp/testing.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import {
  CelEvaluator,
  createExtensionCelEnvironment,
} from "../src/infrastructure/cel/cel_evaluator.ts";

await initializeLogging({});

const MODEL_TYPE = ModelType.create("test/foreign-template-text");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-foreign-template-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("foreign template text: the definition pass and the globalArgs guard agree (swamp-club#2491)", async () => {
  const source = Definition.create({
    name: "deploy-notifier",
    type: MODEL_TYPE.normalized,
    inputs: { properties: { region: { type: "string" } } },
    globalArguments: {
      // Swamp's: a declared input given no value, so evaluation fails.
      region: "${{ inputs.region }}",
      // Swamp's, but cut short at the }} inside its string literal.
      label: '${{ "a}}" + inputs.region }}',
      // GitHub Actions and Datadog text.
      message: "deploy ${{ github.sha }}",
      alert: "crashed on {{host.name}}",
    },
    methods: { run: { arguments: {} } },
  });

  const { definition, failedExpressions } =
    await new DefinitionExpressionEvaluator(new CelEvaluator()).evaluate(
      source,
      { model: {}, env: {}, inputs: {} },
      "unrestricted",
    );
  assertEquals(failedExpressions.has("${{ inputs.region }}"), true);
  assertEquals(failedExpressions.has("${{ github.sha }}"), false);

  const read: Record<string, unknown> = {};
  const method: MethodDefinition = {
    description: "run",
    arguments: z.object({}),
    execute: (_args, context) => {
      read.message = context.globalArgs.message;
      read.alert = context.globalArgs.alert;
      assertThrows(
        () => context.globalArgs.region,
        Error,
        "Unresolved expression in globalArguments.region",
      );
      assertThrows(
        () => context.globalArgs.label,
        Error,
        "Unresolved expression in globalArguments.label",
      );
      return Promise.resolve({});
    },
  };

  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, ".swamp", "data"));
    await ensureDir(join(repoDir, "models"));
    const catalogStore = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    try {
      const context = buildMethodContext(
        {
          dataRepository: new FileSystemUnifiedDataRepository(
            repoDir,
            undefined,
            catalogStore,
          ),
          definitionRepository: new YamlDefinitionRepository(repoDir),
          createCelEnvironment: createExtensionCelEnvironment,
        },
        {
          signal: new AbortController().signal,
          repoDir,
          modelType: MODEL_TYPE,
          modelId: definition.id,
          globalArgs: {},
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            tags: definition.tags,
          },
          methodName: "run",
          logger: getLogger(["test", "foreign-template-text"]),
        },
      );

      await new DefaultMethodExecutionService().execute(
        definition,
        method,
        context,
      );
    } finally {
      catalogStore.close();
    }
  });
  assertEquals(read, {
    message: "deploy ${{ github.sha }}",
    alert: "crashed on {{host.name}}",
  });
});

/**
 * Runs `fn` over a temp repo with a model type, registered per run, whose one
 * global argument is plain text and whose method records what it receives.
 */
async function withDirectRepo(
  fn: (
    repo: ReturnType<typeof createRepositoryContext>,
    dir: string,
    type: ModelType,
    received: unknown[],
  ) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const repo = createRepositoryContext({ repoDir: dir });
    const type = ModelType.create(`test/direct-foreign-${crypto.randomUUID()}`);
    const received: unknown[] = [];
    modelRegistry.register({
      type,
      version: "2026.09.25.1",
      globalArguments: z.object({ message: z.string() }),
      methods: {
        run: {
          description: "Record the message global argument",
          arguments: z.object({}),
          execute: (_args, context) => {
            received.push(context.globalArgs.message);
            return Promise.resolve({ dataHandles: [] });
          },
        },
      },
    });
    try {
      await fn(repo, dir, type, received);
    } finally {
      repo.catalogStore.close();
    }
  });
}

async function executionService(
  repo: ReturnType<typeof createRepositoryContext>,
  dir: string,
) {
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

function directWorkflow(
  name: string,
  type: ModelType,
  message: string,
  extra: {
    inputs?: Workflow["inputs"];
    forEach?: { item: string; in: string };
  } = {},
): Workflow {
  return Workflow.create({
    name,
    ...(extra.inputs ? { inputs: extra.inputs } : {}),
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "capture",
        ...(extra.forEach ? { forEach: extra.forEach } : {}),
        task: StepTask.directExecution(
          type.normalized,
          `${name}-model`,
          "run",
          undefined,
          { message },
        ),
      })],
    })],
  });
}

Deno.test("foreign template text: a direct step scans its authored global arguments (swamp-club#2496)", async () => {
  await withDirectRepo(async (repo, dir, type, received) => {
    await repo.workflowRepo.save(
      directWorkflow("concat", type, '${{ "{" + "{env.name}" + "}" }}'),
    );
    await repo.workflowRepo.save(
      directWorkflow("input", type, "${{ inputs.msg }}", {
        inputs: { type: "object", properties: { msg: { type: "string" } } },
      }),
    );
    await repo.workflowRepo.save(
      directWorkflow("each", type, "${{ self.item }}", {
        inputs: { type: "object", properties: { items: { type: "array" } } },
        forEach: { item: "item", in: "${{ inputs.items }}" },
      }),
    );
    await repo.workflowRepo.save(
      directWorkflow("literal", type, "{{env.name}}"),
    );
    const service = await executionService(repo, dir);

    // CEL concatenation, the documented way to write colliding braces.
    const concat = await service.execute("concat");
    assertEquals(concat.status, "succeeded", JSON.stringify(concat.toData()));
    // A workflow input carrying the text: data, not an authored mistake.
    const input = await service.execute("input", {
      inputs: { msg: "{{env.name}}" },
    });
    assertEquals(input.status, "succeeded", JSON.stringify(input.toData()));
    // A forEach step finds its authored arguments through its template name.
    const each = await service.execute("each", {
      inputs: { items: ["{{env.name}}"] },
    });
    assertEquals(each.status, "succeeded", JSON.stringify(each.toData()));
    assertEquals(received, ["{{env.name}}", "{{env.name}}", "{{env.name}}"]);

    // Resume goes through its own setup; the authored text must reach it too.
    // Resume needs a failed run, so a second step always fails.
    const failing = directWorkflow(
      "resumable",
      type,
      '${{ "{" + "{env.name}" + "}" }}',
    );
    const withFailure = Workflow.create({
      name: failing.name,
      jobs: [Job.create({
        name: "main",
        steps: [
          ...failing.jobs[0].steps,
          Step.create({
            name: "stop",
            task: StepTask.assert("false", "always fails"),
          }),
        ],
      })],
    });
    await repo.workflowRepo.save(withFailure);
    const failed = await service.execute("resumable");
    assertEquals(failed.status, "failed");
    assertEquals(received.length, 4);
    await collect(
      service.resume("resumable", failed.id, { fromStep: "capture" }),
    );
    assertEquals(received, Array(5).fill("{{env.name}}"));

    // Written literally, the braces are still a swamp expression missing its $.
    const literal = await service.execute("literal");
    assertEquals(literal.status, "failed");
    assertStringIncludes(
      JSON.stringify(literal.toData()),
      "Expression uses {{...}} instead of ${{...}}",
    );
    assertEquals(received.length, 5);
  });
});
