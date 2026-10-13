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

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { configure, getLogger, type LogRecord, reset } from "@logtape/logtape";
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

    // Later steps that reuse the auto-definition the concat run saved, without
    // supplying the argument, do not lint its stored evaluated values.
    await repo.workflowRepo.save(Workflow.create({
      name: "reuse-direct",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "capture",
          task: StepTask.directExecution(
            type.normalized,
            "concat-model",
            "run",
          ),
        })],
      })],
    }));
    await repo.workflowRepo.save(Workflow.create({
      name: "reuse-by-name",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "capture",
          task: StepTask.model("concat-model", "run"),
        })],
      })],
    }));
    const reuseDirect = await service.execute("reuse-direct");
    assertEquals(
      reuseDirect.status,
      "succeeded",
      JSON.stringify(reuseDirect.toData()),
    );
    const reuseByName = await service.execute("reuse-by-name");
    assertEquals(
      reuseByName.status,
      "succeeded",
      JSON.stringify(reuseByName.toData()),
    );
    assertEquals(received.length, 5);

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
    assertEquals(received.length, 6);
    await collect(
      service.resume("resumable", failed.id, { fromStep: "capture" }),
    );
    assertEquals(received, Array(7).fill("{{env.name}}"));

    // Written literally, the braces are still a swamp expression missing its $.
    const literal = await service.execute("literal");
    assertEquals(literal.status, "failed");
    assertStringIncludes(
      JSON.stringify(literal.toData()),
      "Expression uses {{...}} instead of ${{...}}",
    );
    assertEquals(received.length, 7);
  });
});

Deno.test("foreign template text: a workflow step's arguments pass it through to the method (swamp-club#2528)", async () => {
  await withTempDir(async (dir) => {
    const repo = createRepositoryContext({ repoDir: dir });
    const type = ModelType.create(
      `test/workflow-foreign-${crypto.randomUUID()}`,
    );
    const received: unknown[] = [];
    modelRegistry.register({
      type,
      version: "2026.10.13.1",
      globalArguments: z.object({
        message: z.string(),
        env: z.record(z.string(), z.string()).optional(),
      }),
      methods: {
        run: {
          description: "Record the global arguments and the note argument",
          arguments: z.object({ note: z.string().optional() }),
          execute: (args, context) => {
            received.push({
              message: context.globalArgs.message,
              sha: (context.globalArgs.env as Record<string, string>)?.SHA,
              note: (args as { note?: string }).note,
            });
            return Promise.resolve({ dataHandles: [] });
          },
        },
      },
    });
    try {
      // A direct step: GitHub Actions text nested in its global arguments.
      await repo.workflowRepo.save(Workflow.create({
        name: "direct",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "capture",
            task: StepTask.directExecution(
              type.normalized,
              "direct-model",
              "run",
              undefined,
              {
                message: "deploy ${{ github.sha }} on ${{ matrix.os }}",
                env: { SHA: "${{ github.sha }}" },
              },
            ),
          })],
        })],
      }));
      // A step on an existing definition: the text in its inputs.
      await repo.definitionRepo.save(
        type,
        Definition.create({
          name: "stored-model",
          type: type.normalized,
          globalArguments: { message: "plain" },
          methods: { run: { arguments: {} } },
        }),
      );
      await repo.workflowRepo.save(Workflow.create({
        name: "stored",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "capture",
            task: StepTask.model("stored-model", "run", {
              note: "ref ${{ github.ref }}",
            }),
          })],
        })],
      }));
      // A nested workflow: the parent's text arrives in the child as an
      // input value, which the child hands to its own step.
      await repo.workflowRepo.save(Workflow.create({
        name: "child",
        inputs: { type: "object", properties: { note: { type: "string" } } },
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "capture",
            task: StepTask.model("stored-model", "run", {
              note: "${{ inputs.note }}",
            }),
          })],
        })],
      }));
      await repo.workflowRepo.save(Workflow.create({
        name: "parent",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "call",
            task: StepTask.workflow("child", { note: "${{ github.actor }}" }),
          })],
        })],
      }));
      // The same text where a step names what it runs is still an error.
      await repo.workflowRepo.save(Workflow.create({
        name: "target",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "capture",
            task: StepTask.model("${{ github.repository }}", "run"),
          })],
        })],
      }));
      const service = await executionService(repo, dir);

      const direct = await service.execute("direct");
      assertEquals(direct.status, "succeeded", JSON.stringify(direct.toData()));
      const stored = await service.execute("stored");
      assertEquals(stored.status, "succeeded", JSON.stringify(stored.toData()));
      assertEquals(received, [
        {
          message: "deploy ${{ github.sha }} on ${{ matrix.os }}",
          sha: "${{ github.sha }}",
          note: undefined,
        },
        { message: "plain", sha: undefined, note: "ref ${{ github.ref }}" },
      ]);
      const parent = await service.execute("parent");
      assertEquals(parent.status, "succeeded", JSON.stringify(parent.toData()));
      assertEquals(received[2], {
        message: "plain",
        sha: undefined,
        note: "${{ github.actor }}",
      });

      await assertRejects(
        () => service.execute("target"),
        Error,
        "Unknown variable: github",
      );
      assertEquals(received.length, 3);
    } finally {
      repo.catalogStore.close();
    }
  });
});

/** Runs `fn` with the expression logger's warnings captured, as messages. */
async function capturingRunWarnings(
  fn: () => Promise<void>,
): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["swamp", "expressions"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) => record.message.map(String).join(""));
}

Deno.test("foreign template text: a run and its resume warn about each step argument passed through (swamp-club#2528)", async () => {
  await withDirectRepo(async (repo, dir, type) => {
    await repo.definitionRepo.save(
      type,
      Definition.create({
        name: "stored-model",
        type: type.normalized,
        globalArguments: { message: "${{ inputs.note }}" },
        inputs: { properties: { note: { type: "string" } } },
        methods: { run: { arguments: {} } },
      }),
    );
    const step = (name: string, task: StepTask) => Step.create({ name, task });
    await repo.workflowRepo.save(Workflow.create({
      name: "passed",
      jobs: [Job.create({
        name: "main",
        steps: [
          step(
            "capture",
            StepTask.model("stored-model", "run", {
              note: "${{ github.actor }}",
            }),
          ),
          step("stop", StepTask.assert("false", "always fails")),
        ],
      })],
    }));
    await repo.workflowRepo.save(Workflow.create({
      name: "clean",
      jobs: [Job.create({
        name: "main",
        steps: [
          step("capture", StepTask.model("stored-model", "run", { note: "x" })),
        ],
      })],
    }));
    const service = await executionService(repo, dir);
    const expected =
      "Template syntax passed through in workflow passed, job main, step capture: inputs.note holds ${{ github.actor }}, which is not a swamp expression, so the step receives it as literal text";

    let failedId = "";
    const onRun = await capturingRunWarnings(async () => {
      const failed = await service.execute("passed");
      assertEquals(failed.status, "failed");
      failedId = failed.id;
    });
    assertEquals(onRun.filter((m) => m.includes("Template syntax")), [
      expected,
    ]);

    const onResume = await capturingRunWarnings(async () => {
      await collect(
        service.resume("passed", failedId, { fromStep: "capture" }),
      );
    });
    assertEquals(onResume.filter((m) => m.includes("Template syntax")), [
      expected,
    ]);

    const onClean = await capturingRunWarnings(async () => {
      const clean = await service.execute("clean");
      assertEquals(clean.status, "succeeded", JSON.stringify(clean.toData()));
    });
    assertEquals(onClean.filter((m) => m.includes("Template syntax")), []);
  });
});

Deno.test("foreign template text: only known foreign roots pass through step arguments (swamp-club#3400)", async () => {
  await withDirectRepo(async (repo, dir, type, received) => {
    await repo.definitionRepo.save(
      type,
      Definition.create({
        name: "stored-model",
        type: type.normalized,
        globalArguments: { message: "${{ inputs.note }}" },
        inputs: { properties: { note: { type: "string" } } },
        methods: { run: { arguments: {} } },
      }),
    );
    const stored = (name: string, note: string) =>
      Workflow.create({
        name,
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "capture",
            task: StepTask.model("stored-model", "run", { note }),
          })],
        })],
      });
    // A made-up or misspelt root, in step inputs and in a direct step's
    // global arguments. A known root beside it does not excuse it.
    const rejected: [Workflow, string][] = [
      [
        stored("inputs-unlisted", "echo ${{ nonexistent.variable }}"),
        "Unknown variable: nonexistent",
      ],
      [
        stored("inputs-misspelt", "${{ input.region }}"),
        "Unknown variable: input",
      ],
      [
        directWorkflow("direct-unlisted", type, "${{ nonexistent.variable }}"),
        "Unknown variable: nonexistent",
      ],
      [
        directWorkflow("mixed", type, "${{ github.sha + nonexistent.x }}"),
        "Unknown variable: github",
      ],
    ];
    // A nested workflow's input value follows the same rule.
    await repo.workflowRepo.save(Workflow.create({
      name: "child",
      inputs: { type: "object", properties: { note: { type: "string" } } },
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "capture",
          task: StepTask.model("stored-model", "run", {
            note: "${{ inputs.note }}",
          }),
        })],
      })],
    }));
    rejected.push([
      Workflow.create({
        name: "parent",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "call",
            task: StepTask.workflow("child", {
              note: "${{ nonexistent.actor }}",
            }),
          })],
        })],
      }),
      "Unknown variable: nonexistent",
    ]);
    const service = await executionService(repo, dir);
    for (const [workflow, message] of rejected) {
      await repo.workflowRepo.save(workflow);
      // The run fails before any step starts.
      await assertRejects(
        () => service.execute(workflow.name),
        Error,
        message,
      );
    }
    assertEquals(received, []);

    // A known root still reaches the method, hyphenated name and all, and
    // literal() still carries any text through step inputs.
    const passed = [
      stored("known", "${{ matrix.node-version }}"),
      stored("literal", "${{ literal('${{ nonexistent.variable }}') }}"),
    ];
    for (const workflow of passed) {
      await repo.workflowRepo.save(workflow);
      const run = await service.execute(workflow.name);
      assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    }
    assertEquals(received, [
      "${{ matrix.node-version }}",
      "${{ nonexistent.variable }}",
    ]);
  });
});

Deno.test("foreign template text: an unlisted root deferred past run start fails when its step runs (swamp-club#3400)", async () => {
  await withDirectRepo(async (repo, dir, type, received) => {
    await repo.definitionRepo.save(
      type,
      Definition.create({
        name: "stored-model",
        type: type.normalized,
        globalArguments: { message: "${{ inputs.note }}" },
        inputs: { properties: { note: { type: "string" } } },
        methods: { run: { arguments: {} } },
      }),
    );
    // Deferred by self.*, so only the step-time pass sees it.
    await repo.workflowRepo.save(Workflow.create({
      name: "deferred-inputs",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "capture",
          forEach: { item: "h", in: '${{ ["a"] }}' },
          task: StepTask.model("stored-model", "run", {
            note: "${{ self.h + nonexistent.os }}",
          }),
        })],
      })],
    }));
    await repo.workflowRepo.save(
      directWorkflow(
        "deferred-direct",
        type,
        "${{ self.h + nonexistent.os }}",
        {
          forEach: { item: "h", in: '${{ ["a"] }}' },
        },
      ),
    );
    // A direct step whose inputs carry it, with no global arguments.
    await repo.workflowRepo.save(Workflow.create({
      name: "deferred-direct-inputs",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "capture",
          forEach: { item: "h", in: '${{ ["a"] }}' },
          task: StepTask.directExecution(
            type.normalized,
            "deferred-direct-inputs-model",
            "run",
            { message: "${{ self.h + nonexistent.os }}" },
          ),
        })],
      })],
    }));
    const service = await executionService(repo, dir);
    for (
      const name of [
        "deferred-inputs",
        "deferred-direct",
        "deferred-direct-inputs",
      ]
    ) {
      const warnings = await capturingRunWarnings(async () => {
        const run = await service.execute(name);
        assertEquals(run.status, "failed", name);
        assertStringIncludes(
          JSON.stringify(run.toData()),
          "Unknown variable: nonexistent",
        );
      });
      assertEquals(warnings.filter((m) => m.includes("Template syntax")), []);
    }
    assertEquals(received, []);
  });
});

Deno.test("foreign template text: outside step arguments it still fails when the step runs (swamp-club#2528)", async () => {
  await withDirectRepo(async (repo, dir, type, received) => {
    // Deferred past run start by self.*, so only the step-time pass sees it.
    await repo.workflowRepo.save(Workflow.create({
      name: "placement",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "capture",
          forEach: { item: "h", in: '${{ ["a"] }}' },
          labels: { os: "${{ self.h + runner.os }}" },
          task: StepTask.directExecution(
            type.normalized,
            "placement-model",
            "run",
            undefined,
            { message: "plain" },
          ),
        })],
      })],
    }));
    const service = await executionService(repo, dir);
    const run = await service.execute("placement");
    assertEquals(run.status, "failed");
    assertStringIncludes(
      JSON.stringify(run.toData()),
      "Unknown variable: runner",
    );
    assertEquals(received, []);
  });
});

Deno.test("foreign template text: a run warns about step arguments deferred past run start (swamp-club#2528)", async () => {
  await withDirectRepo(async (repo, dir, type, received) => {
    await repo.workflowRepo.save(Workflow.create({
      name: "deferred",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "capture",
          forEach: { item: "h", in: '${{ ["a", "b"] }}' },
          task: StepTask.directExecution(
            type.normalized,
            "deferred-model",
            "run",
            undefined,
            { message: "${{ self.h + matrix.os }}" },
          ),
        })],
      })],
    }));
    const service = await executionService(repo, dir);
    const warnings = await capturingRunWarnings(async () => {
      const run = await service.execute("deferred");
      assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    });
    assertEquals(received, [
      "${{ self.h + matrix.os }}",
      "${{ self.h + matrix.os }}",
    ]);
    // Once for the step as authored, not once per iteration.
    assertEquals(warnings.filter((m) => m.includes("Template syntax")), [
      "Template syntax passed through in workflow deferred, job main, step capture: globalArgs.message holds ${{ self.h + matrix.os }}, which reads a name swamp does not provide. Unless it evaluates when the step runs, the step receives it as literal text",
    ]);
  });
});
