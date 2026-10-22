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

/**
 * A behavior run whose sensitive argument takes its value from the run's
 * inputs, through the real evaluation and execution services on a
 * throwaway repository (swamp-club#3681). An operator-typed value is the
 * run's data: it reaches the method, and a method that echoes it in its
 * error lands it in neither the error nor the failure record. A run whose
 * arguments the schema refuses leaves the last good evaluated cache as it
 * was.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import {
  Definition,
  type InputsSchema,
} from "../src/domain/definitions/definition.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createModelMethodRunDeps } from "../src/serve/deps.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  modelMethodRun,
  type ModelMethodRunEvent,
} from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const VAULT = "secrets";
const VAULT_VALUE = "VAULT-VALUE-3681-c0ffee";
const VAULT_REF = `\${{ vault.get('${VAULT}', 'probe') }}`;

const secret = z.string().meta({ sensitive: true });

interface Harness {
  dir: string;
  type: ModelType;
  /** The arguments each method call received, in order. */
  received: Record<string, unknown>[];
  canary: string;
}

/**
 * A repository with one local vault holding `probe`, and a type whose
 * methods record the arguments they receive. Each takes a sensitive string:
 * `execute` returns, and the others throw something that echoes it, `fail`
 * an Error, `failText` the bare string.
 */
async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-3681-inputs-" });
  const type = ModelType.create(`@test/input-values-${crypto.randomUUID()}`);
  const received: Record<string, unknown>[] = [];
  const canary = `CANARY-3681-${crypto.randomUUID().replaceAll("-", "")}`;
  const failures: Record<string, (args: Record<string, unknown>) => string> = {
    fail: (args) => `intentional failure ${args.token}`,
  };
  const thrown: Record<string, (args: Record<string, unknown>) => unknown> = {
    failText: (args) => `intentional failure ${args.token}`,
  };
  const record = (name: string) => (args: unknown) => {
    received.push(args as Record<string, unknown>);
    const failure = failures[name];
    if (failure) throw new Error(failure(args as Record<string, unknown>));
    const value = thrown[name];
    if (value) throw value(args as Record<string, unknown>);
    return Promise.resolve({ dataHandles: [] });
  };
  const method = (name: string, args: z.ZodTypeAny) => ({
    description: name,
    arguments: args,
    execute: record(name),
  });
  modelRegistry.register({
    type,
    version: "2026.10.21.1",
    methods: {
      execute: method("execute", z.object({ token: secret.optional() })),
      fail: method("fail", z.object({ token: secret })),
      failText: method("failText", z.object({ token: secret })),
    },
  });
  try {
    await initializeTestRepo(dir);
    await new YamlVaultConfigRepository(dir).save(
      VaultConfig.create(crypto.randomUUID(), VAULT, "local_encryption", {
        auto_generate: true,
        base_dir: dir,
      }),
    );
    const vault = await VaultService.fromRepository(dir);
    await vault.put(VAULT, "probe", VAULT_VALUE);
    await fn({ dir, type, received, canary });
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const KEY_INPUT: InputsSchema = {
  type: "object",
  properties: { key: {} },
  required: ["key"],
};

/** Saves a definition of `method` whose arguments read `inputs.key`. */
async function define(
  h: Harness,
  name: string,
  method: string,
  args: Record<string, unknown>,
  inputs: Record<string, unknown> | undefined = KEY_INPUT,
): Promise<Definition> {
  const repo = createRepositoryContext({ repoDir: h.dir });
  try {
    const definition = Definition.create({
      name,
      type: h.type.normalized,
      ...(inputs ? { inputs } : {}),
      methods: { [method]: { arguments: args } },
    });
    await repo.definitionRepo.save(h.type, definition);
    return definition;
  } finally {
    repo.catalogStore.close();
  }
}

async function run(
  h: Harness,
  name: string,
  method: string,
  inputs: Record<string, unknown> = {},
  options: { lastEvaluated?: boolean } = {},
): Promise<ModelMethodRunEvent[]> {
  const repo = createRepositoryContext({ repoDir: h.dir });
  try {
    const deps = await createModelMethodRunDeps(h.dir, repo);
    return await collect(
      modelMethodRun(createLibSwampContext(), deps, {
        modelIdOrName: name,
        methodName: method,
        inputs,
        lastEvaluated: options.lastEvaluated ?? false,
      }),
    );
  } finally {
    repo.catalogStore.close();
  }
}

/**
 * Runs a workflow of one step that forwards the workflow's `key` input to
 * `method` of the definition `name`, and returns the run with its error.
 */
async function runStep(
  h: Harness,
  name: string,
  method: string,
  key: unknown,
): Promise<{ status: string; error: string; record: string }> {
  const repo = createRepositoryContext({ repoDir: h.dir });
  try {
    const workflow = Workflow.create({
      name: `${name}-flow`,
      inputs: KEY_INPUT,
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "probe",
              task: StepTask.model(name, method, { key: "${{ inputs.key }}" }),
            }),
          ],
        }),
      ],
    });
    await repo.workflowRepo.save(workflow);
    const service = new WorkflowExecutionService(
      repo.workflowRepo,
      repo.workflowRunRepo,
      h.dir,
      undefined,
      undefined,
      repo.catalogStore,
    );
    const run = await service.execute(workflow.name, { inputs: { key } });
    const { inputs: _recorded, ...record } = run.toData() as Record<
      string,
      unknown
    >;
    return {
      status: run.status,
      error: run.getJob("main")?.getStep("probe")?.error ?? "",
      record: JSON.stringify(record),
    };
  } finally {
    repo.catalogStore.close();
  }
}

function errorsOf(events: ModelMethodRunEvent[]) {
  return events.flatMap((event) => event.kind === "error" ? [event.error] : []);
}

/** Every file under `root` holding `text`. */
async function filesHolding(root: string, text: string): Promise<string[]> {
  const hits: string[] = [];
  for await (const entry of walk(root, { includeDirs: false })) {
    if ((await Deno.readTextFile(entry.path)).includes(text)) {
      hits.push(entry.path);
    }
  }
  return hits;
}

async function cacheFile(dir: string, name: string): Promise<string> {
  for await (
    const entry of walk(join(dir, ".swamp", "definitions-evaluated"), {
      includeDirs: false,
      match: [new RegExp(`${name}\\.yaml$`)],
    })
  ) {
    return entry.path;
  }
  throw new Error(`no evaluated cache for ${name}`);
}

Deno.test("input values: a method that echoes a sensitive argument in its error shows the mask in the error event and the failure record (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    await define(h, "echo", "fail", { token: "${{ inputs.key }}" });
    const events = await run(h, "echo", "fail", { key: h.canary });
    assertEquals(h.received, [{ token: h.canary }]);
    const errors = errorsOf(events);
    assertEquals(errors.map((error) => error.code), [
      "method_execution_failed",
    ]);
    assertEquals(errors[0].message, "intentional failure ***");
    assertEquals(
      (errors[0].cause?.stack ?? "").includes(h.canary),
      false,
    );
    assertEquals(
      await filesHolding(join(h.dir, ".swamp", "outputs"), h.canary),
      [],
    );
  });
});

Deno.test("input values: a workflow step whose method echoes a sensitive argument records the mask in the step's error and the output record (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    await define(h, "wf-echo", "fail", { token: "${{ inputs.key }}" });
    const repo = createRepositoryContext({ repoDir: h.dir });
    try {
      const workflow = Workflow.create({
        name: "echo-flow",
        inputs: KEY_INPUT,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "probe",
                task: StepTask.model("wf-echo", "fail", {
                  key: "${{ inputs.key }}",
                }),
              }),
            ],
          }),
        ],
      });
      await repo.workflowRepo.save(workflow);
      const service = new WorkflowExecutionService(
        repo.workflowRepo,
        repo.workflowRunRepo,
        h.dir,
        undefined,
        undefined,
        repo.catalogStore,
      );
      const run = await service.execute(workflow.name, {
        inputs: { key: h.canary },
      });
      assertEquals(run.status, "failed");
      assertEquals(h.received, [{ token: h.canary }]);
      const error = run.getJob("main")?.getStep("probe")?.error ?? "";
      assertStringIncludes(error, "intentional failure ***");
      assertEquals(error.includes(h.canary), false);
      // The run record keeps the inert workflow input it was given, as
      // documented, and nothing else of it; the method's output record and
      // log do not hold the value either.
      const { inputs: _recorded, ...record } = run.toData() as Record<
        string,
        unknown
      >;
      assertEquals(JSON.stringify(record).includes(h.canary), false);
      assertEquals(
        await filesHolding(join(h.dir, ".swamp", "outputs"), h.canary),
        [],
      );
    } finally {
      repo.catalogStore.close();
    }
  });
});

Deno.test("input values: a method that throws a string echoing a sensitive argument shows the mask in the error event, a workflow step's error and the output records (swamp-club#3746)", async () => {
  await withHarness(async (h) => {
    await define(h, "text", "failText", { token: "${{ inputs.key }}" });
    const events = await run(h, "text", "failText", { key: h.canary });
    const errors = errorsOf(events);
    assertEquals(errors.map((error) => error.code), [
      "method_execution_failed",
    ]);
    assertEquals(errors[0].message, "intentional failure ***");
    const step = await runStep(h, "text", "failText", h.canary);
    assertEquals(step.status, "failed");
    assertEquals(h.received, [{ token: h.canary }, { token: h.canary }]);
    assertStringIncludes(step.error, "intentional failure ***");
    assertEquals(step.error.includes(h.canary), false);
    assertEquals(step.record.includes(h.canary), false);
    assertEquals(
      await filesHolding(join(h.dir, ".swamp", "outputs"), h.canary),
      [],
    );
  });
});

Deno.test("input values: arguments the schema refuses never replace the last good evaluated cache (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    const definition = await define(h, "seeded", "execute", {
      token: VAULT_REF,
    }, undefined);
    assertEquals(errorsOf(await run(h, "seeded", "execute")), []);
    const path = await cacheFile(h.dir, "seeded");
    const good = await Deno.readTextFile(path);

    const repo = createRepositoryContext({ repoDir: h.dir });
    try {
      await repo.definitionRepo.save(
        h.type,
        Definition.fromData({
          ...definition.toData(),
          methods: { execute: { arguments: { token: { invalid: true } } } },
        }),
      );
      const refused = errorsOf(await run(h, "seeded", "execute"));
      assertEquals(refused.length, 1);
      assertStringIncludes(
        refused[0].message,
        "Method arguments validation failed",
      );
      assertEquals(h.received.length, 1);
      assertEquals(await Deno.readTextFile(path), good);

      await repo.definitionRepo.save(h.type, definition);
    } finally {
      repo.catalogStore.close();
    }
    const replay = await run(h, "seeded", "execute", {}, {
      lastEvaluated: true,
    });
    assertEquals(errorsOf(replay), []);
    assertEquals(h.received, [{ token: VAULT_VALUE }, { token: VAULT_VALUE }]);
  });
});
