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

// Integration test for swamp-club#2492: one value can mix a swamp expression
// with another service's `{{...}}` text through literal(). The raw text of
// each `${{ ... }}` keys the values the definition pass, the workflow passes,
// forEach expansion, trigger inputs and deferred records carry, so every one
// of them must agree on where an expression holding a `}}` in a string ends.

import { assertEquals, assertThrows } from "@std/assert";
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
import { modelRegistry } from "../src/domain/models/model.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { TriggerInputResolver } from "../src/domain/workflows/trigger_input_resolver.ts";
import { DeferredExpressionSchema } from "../src/domain/expressions/deferred_expression.ts";
import { scanTemplateSyntax } from "../src/domain/models/template_syntax_scan.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import {
  CelEvaluator,
  createExtensionCelEnvironment,
} from "../src/infrastructure/cel/cel_evaluator.ts";

await initializeLogging({});

/** The value from the issue: a swamp input beside Datadog template text. */
const MIXED =
  "${{ inputs.env }} alert, crashed on ${{ literal('{{host.name}}') }}";
const EXPECTED = "prod alert, crashed on {{host.name}}";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-literal-expression-" });
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

Deno.test("literal(): a global argument mixing swamp and foreign text reaches the method (swamp-club#2492)", async () => {
  const type = ModelType.create("test/literal-expression");
  const source = Definition.create({
    name: "alert-notifier",
    type: type.normalized,
    inputs: { properties: { env: { type: "string" } } },
    globalArguments: {
      message: MIXED,
      // Documented limitation: literal() cannot emit `${{ ... }}` text that
      // names a swamp namespace. The guard reads the evaluated text as an
      // unresolved swamp expression.
      version: "${{ literal('${{ inputs.version }}') }}",
    },
    methods: {
      run: {
        arguments: {
          // A method argument is not re-guarded after evaluation, so
          // literal() can pass swamp-looking text through there.
          workflowYaml:
            "sha: ${{ literal('${{ github.sha }} ${{ inputs.version }}') }}",
        },
      },
    },
  });

  // Model validate's template-syntax scan finds nothing to report.
  assertEquals(
    scanTemplateSyntax(
      { globalArguments: { message: MIXED } },
      { declaredInputs: new Set(["env"]) },
    ),
    { malformed: [], foreign: [] },
  );

  const { definition, failedExpressions } =
    await new DefinitionExpressionEvaluator(new CelEvaluator()).evaluate(
      source,
      { model: {}, env: {}, inputs: { env: "prod" } },
      "unrestricted",
    );
  assertEquals(failedExpressions.size, 0);
  assertEquals(definition.globalArguments.message, EXPECTED);

  const read: Record<string, unknown> = {};
  const method: MethodDefinition = {
    description: "run",
    arguments: z.object({ workflowYaml: z.string() }),
    execute: (args, context) => {
      read.workflowYaml = (args as { workflowYaml: string }).workflowYaml;
      read.message = context.globalArgs.message;
      assertThrows(
        () => context.globalArgs.version,
        Error,
        "Unresolved expression in globalArguments.version",
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
          modelType: type,
          modelId: definition.id,
          globalArgs: {},
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            tags: definition.tags,
          },
          methodName: "run",
          logger: getLogger(["test", "literal-expression"]),
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
    workflowYaml: "sha: ${{ github.sha }} ${{ inputs.version }}",
    message: EXPECTED,
  });
});

Deno.test("literal(): workflow inputs, a direct step's global arguments and forEach.in agree on the expressions (swamp-club#2492)", async () => {
  await withTempDir(async (dir) => {
    const repo = createRepositoryContext({ repoDir: dir });
    const type = ModelType.create(`test/literal-direct-${crypto.randomUUID()}`);
    const received: unknown[] = [];
    modelRegistry.register({
      type,
      version: "2026.09.29.1",
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
      const step = (message: string, forEach?: { item: string; in: string }) =>
        Step.create({
          name: "capture",
          ...(forEach ? { forEach } : {}),
          task: StepTask.directExecution(
            type.normalized,
            `${forEach ? "each" : "mixed"}-model`,
            "run",
            undefined,
            { message },
          ),
        });
      await repo.workflowRepo.save(Workflow.create({
        name: "mixed",
        inputs: { type: "object", properties: { env: { type: "string" } } },
        jobs: [Job.create({ name: "main", steps: [step(MIXED)] })],
      }));
      await repo.workflowRepo.save(Workflow.create({
        name: "each",
        jobs: [Job.create({
          name: "main",
          steps: [step("${{ self.item }} on ${{ literal('{{host.name}}') }}", {
            item: "item",
            // A }} inside a string in forEach.in, keyed by its raw text. One
            // item: iterations sharing a modelName race on the definition's
            // global arguments when it is first created (swamp-club#2713).
            in: "${{ [literal('}}a {{b}}')] }}",
          })],
        })],
      }));

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

      const mixed = await service.execute("mixed", { inputs: { env: "prod" } });
      assertEquals(mixed.status, "succeeded", JSON.stringify(mixed.toData()));
      const each = await service.execute("each");
      assertEquals(each.status, "succeeded", JSON.stringify(each.toData()));
      assertEquals(received, [EXPECTED, "}}a {{b}} on {{host.name}}"]);
    } finally {
      repo.catalogStore.close();
    }
  });
});

Deno.test("literal(): trigger inputs resolve a value mixing webhook data and foreign text (swamp-club#2492)", async () => {
  const resolved = await new TriggerInputResolver(new CelEvaluator()).resolve(
    {
      message:
        "${{ webhook.body.env }} alert, crashed on ${{ literal('{{host.name}}') }}",
    },
    {
      model: {},
      env: {},
      webhook: { body: { env: "prod" }, headers: {}, route: "/alert" },
    },
  );
  assertEquals(resolved, { message: EXPECTED });
});

Deno.test("literal(): a deferred expression holding a }} in a string round-trips its record (swamp-club#2492)", () => {
  const record = {
    id: crypto.randomUUID(),
    expression: "${{ vault.get('v', 'k') + literal('}}') }}",
    bindings: {},
  };
  assertEquals(DeferredExpressionSchema.parse(record), record);
  // A record is exactly one expression, as before.
  assertThrows(() =>
    DeferredExpressionSchema.parse({
      ...record,
      expression: "${{ vault.get('v', 'k') }} ",
    })
  );
});
