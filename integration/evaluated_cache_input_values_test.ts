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
 * was, and a parse the schema refuses or a transform that throws shows
 * nothing of what the transform made of the value.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { UserError } from "../src/domain/errors.ts";
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

/** The number a sensitive numeric argument takes in these runs. */
const PIN = 73816542;

/**
 * A repository with one local vault holding `probe`, and a type whose
 * methods record the arguments they receive. Each takes a sensitive string:
 * `execute` returns, and the others throw something that echoes it, `fail`
 * an Error, `failText` the bare string, `failCoded` a UserError whose code
 * holds it.
 * `failKeys` throws an error that echoes the keys of a sensitive record,
 * `failNumber` a sensitive number, `failTransformed` what the schema's
 * transform made of the string, `failMadeKeys` the keys a transform derived
 * from the string; `failUnrelated` takes a record of sensitive strings and
 * throws a fixed text that holds its keys only as fragments of other words.
 * `storePin` writes its sensitive number into a `pinned` resource as a
 * number node, beside a larger number that holds its digits and a note that
 * spells it.
 * The `refuse*` and `throwMade` methods never run: their schemas refuse
 * what the transform made of the string, through an issue that echoes it
 * (`refuseMade` on the field, `refusePiped` in a pipeline's output) or by
 * throwing (`throwMade`).
 */
async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-3681-inputs-" });
  const type = ModelType.create(`@test/input-values-${crypto.randomUUID()}`);
  const received: Record<string, unknown>[] = [];
  const canary = `CANARY-3681-${crypto.randomUUID().replaceAll("-", "")}`;
  const failures: Record<string, (args: Record<string, unknown>) => string> = {
    fail: (args) => `intentional failure ${args.token}`,
    failKeys: (args) =>
      `intentional failure keys ${
        Object.keys(args.tokens as Record<string, unknown>).join(",")
      }`,
    failNumber: (args) => `intentional failure pin ${args.pin}`,
    failUnrelated: () => "intentional failure production dummy-db",
    failTransformed: (args) => `intentional failure ${args.token}`,
    failMadeKeys: (args) =>
      `intentional failure keys ${
        Object.keys(args.tokens as Record<string, unknown>).join(",")
      }`,
  };
  const thrown: Record<string, (args: Record<string, unknown>) => unknown> = {
    failText: (args) => `intentional failure ${args.token}`,
    failCoded: (args) =>
      new UserError("intentional failure", `auth_failed_${args.token}`),
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
    resources: {
      pinned: {
        description: "What storePin wrote",
        schema: z.object({
          pin: z.number(),
          rows: z.number(),
          note: z.string(),
        }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
    },
    methods: {
      storePin: {
        description: "storePin",
        arguments: z.object({ pin: z.number().meta({ sensitive: true }) }),
        execute: async (args, context) => {
          received.push(args as Record<string, unknown>);
          const pin = (args as { pin: number }).pin;
          const handle = await context.writeResource!("pinned", "main", {
            pin,
            rows: pin * 10 + 1,
            note: `pin ${pin}`,
          });
          return { dataHandles: [handle] };
        },
      },
      execute: method("execute", z.object({ token: secret.optional() })),
      fail: method("fail", z.object({ token: secret })),
      failText: method("failText", z.object({ token: secret })),
      failCoded: method("failCoded", z.object({ token: secret })),
      failKeys: method(
        "failKeys",
        z.object({
          tokens: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
        }),
      ),
      failNumber: method(
        "failNumber",
        z.object({ pin: z.number().meta({ sensitive: true }) }),
      ),
      failUnrelated: method(
        "failUnrelated",
        z.object({ tokens: z.record(z.string(), secret) }),
      ),
      failTransformed: method(
        "failTransformed",
        z.object({
          token: secret.transform((text) => text.split("").reverse().join("")),
        }),
      ),
      failMadeKeys: method(
        "failMadeKeys",
        z.object({ raw: z.string() }).transform((x) => ({
          tokens: { [x.raw.toUpperCase()]: null } as Record<string, unknown>,
        })).pipe(
          z.object({
            tokens: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
          }),
        ),
      ),
      refuseMade: method(
        "refuseMade",
        z.object({
          token: secret.transform((text) => text.toUpperCase()).refine(
            () => false,
            {
              error: (issue) =>
                `normalized credential rejected: ${String(issue.input)}`,
            },
          ),
        }),
      ),
      refusePiped: method(
        "refusePiped",
        z.object({ raw: z.string() }).transform((x) => ({
          token: x.raw.toUpperCase(),
        })).pipe(
          z.object({
            token: secret.refine(() => false, {
              error: (issue) =>
                `pipeline credential rejected: ${String(issue.input)}`,
            }),
          }),
        ),
      ),
      throwMade: method(
        "throwMade",
        z.object({
          token: secret.transform((text): string => {
            throw new Error(
              `normalized credential rejected: ${text.toUpperCase()}`,
            );
          }),
        }),
      ),
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

/** Every file under `.swamp` (the cache, outputs, logs, runs) holding `text`. */
function swampFilesHolding(dir: string, text: string): Promise<string[]> {
  return filesHolding(join(dir, ".swamp"), text);
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

async function cacheOf(
  dir: string,
  name: string,
): Promise<Record<string, unknown>> {
  return parseYaml(
    await Deno.readTextFile(await cacheFile(dir, name)),
  ) as Record<
    string,
    unknown
  >;
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

Deno.test("input values: a workflow step whose method throws a UserError with a code echoing a sensitive argument records the code masked (swamp-club#3773)", async () => {
  await withHarness(async (h) => {
    await define(h, "coded", "failCoded", { token: "${{ inputs.key }}" });
    const step = await runStep(h, "coded", "failCoded", h.canary);
    assertEquals(step.status, "failed");
    assertEquals(h.received, [{ token: h.canary }]);
    assertEquals(step.error, "intentional failure");
    assertStringIncludes(step.record, '"errorCode":"auth_failed_***"');
    assertEquals(step.record.includes(h.canary), false);
  });
});

Deno.test("input values: the keys of a sensitive record an input supplied are not redactor secrets, so a method that echoes them shows them as written and unrelated output that holds a key as a fragment is stored intact (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    // Keys are identifiers, often short common words. Registered with the
    // redactor they would corrupt every stored text that contains them:
    // `production` would read `***uction`.
    await define(h, "unrelated", "failUnrelated", {
      tokens: "${{ inputs.key }}",
    });
    const events = await run(h, "unrelated", "failUnrelated", {
      key: { prod: h.canary, dummy: h.canary },
    });
    assertEquals(h.received, [{ tokens: { prod: h.canary, dummy: h.canary } }]);
    const errors = errorsOf(events);
    assertEquals(errors.map((error) => error.code), [
      "method_execution_failed",
    ]);
    assertEquals(errors[0].message, "intentional failure production dummy-db");
    assertEquals(
      (await filesHolding(
        join(h.dir, ".swamp", "outputs"),
        "intentional failure production dummy-db",
      )).length > 0,
      true,
    );
    assertEquals(await swampFilesHolding(h.dir, "***uction"), []);
    // The values are secrets and stay out of every file.
    assertEquals(await swampFilesHolding(h.dir, h.canary), []);

    // A method that echoes the keys of a sensitive record shows them as it
    // wrote them.
    await define(h, "echo-keys", "failKeys", { tokens: "${{ inputs.key }}" });
    const echoed = errorsOf(
      await run(h, "echo-keys", "failKeys", { key: { [h.canary]: null } }),
    );
    assertEquals(h.received.at(-1), { tokens: { [h.canary]: null } });
    assertEquals(echoed.map((error) => error.code), [
      "method_execution_failed",
    ]);
    assertEquals(echoed[0].message, `intentional failure keys ${h.canary}`);
  });
});

Deno.test("input values: a method that echoes a sensitive number shows the mask in the error event and the failure record (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    await define(h, "echo-pin", "failNumber", { pin: "${{ inputs.key }}" });
    const events = await run(h, "echo-pin", "failNumber", { key: PIN });
    assertEquals(h.received, [{ pin: PIN }]);
    const errors = errorsOf(events);
    assertEquals(errors.map((error) => error.code), [
      "method_execution_failed",
    ]);
    assertEquals(errors[0].message, "intentional failure pin ***");
    assertEquals(await swampFilesHolding(h.dir, String(PIN)), []);
  });
});

Deno.test("input values: a resource holding a sensitive number as a number node is stored as valid JSON with the mask at that node, while a larger number holding its digits is kept (swamp-club#3754)", async () => {
  await withHarness(async (h) => {
    await define(h, "store-pin", "storePin", { pin: "${{ inputs.key }}" });
    const events = await run(h, "store-pin", "storePin", { key: PIN });
    assertEquals(errorsOf(events), []);
    assertEquals(h.received, [{ pin: PIN }]);
    const rows = PIN * 10 + 1;
    const stored = await filesHolding(
      join(h.dir, ".swamp", "data"),
      `"rows":${rows}`,
    );
    assertEquals(stored.length, 1);
    assertEquals(JSON.parse(await Deno.readTextFile(stored[0])), {
      pin: "***",
      rows,
      note: "pin ***",
    });
  });
});

Deno.test("input values: a method that echoes what its schema's transform made of a sensitive argument shows the mask in the error event and the failure record (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    await define(h, "echo-made", "failTransformed", {
      token: "${{ inputs.key }}",
    });
    const made = h.canary.split("").reverse().join("");
    const events = await run(h, "echo-made", "failTransformed", {
      key: h.canary,
    });
    assertEquals(h.received, [{ token: made }]);
    const errors = errorsOf(events);
    assertEquals(errors.map((error) => error.code), [
      "method_execution_failed",
    ]);
    assertEquals(errors[0].message, "intentional failure ***");
    assertEquals(await swampFilesHolding(h.dir, made), []);
    assertEquals(await swampFilesHolding(h.dir, h.canary), []);
  });
});

Deno.test("input values: a workflow step whose method echoes the keys of a sensitive record the workflow's input supplied shows them as written in the step's error, while the evaluated definition masks the record whole (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    await define(h, "wf-keys", "failKeys", { tokens: "${{ inputs.key }}" });
    const repo = createRepositoryContext({ repoDir: h.dir });
    try {
      const workflow = Workflow.create({
        name: "keys-flow",
        inputs: KEY_INPUT,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "probe",
                task: StepTask.model("wf-keys", "failKeys", {
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
        inputs: { key: { [h.canary]: null } },
      });
      assertEquals(run.status, "failed");
      assertEquals(h.received, [{ tokens: { [h.canary]: null } }]);
      const error = run.getJob("main")?.getStep("probe")?.error ?? "";
      assertStringIncludes(error, `intentional failure keys ${h.canary}`);
      // The run record keeps the workflow input it was given, as the replay
      // pins it, and the step's error as the method wrote it. The evaluated
      // definition holds the sensitive record only as the mask.
      const cache = await cacheOf(h.dir, "wf-keys");
      assertEquals(
        (cache.methods as Record<string, { arguments: { tokens: unknown } }>)
          .failKeys.arguments.tokens,
        "***",
      );
    } finally {
      repo.catalogStore.close();
    }
  });
});

Deno.test("input values: a parse the schema refuses under a transform is described in Zod's words and shows nothing of what the transform made of a sensitive argument, in the error event, the failure record and a workflow step's error (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    const made = h.canary.toUpperCase();
    for (
      const [name, method, field] of [
        ["refuse-made", "refuseMade", "token"],
        ["refuse-piped", "refusePiped", "raw"],
      ] as const
    ) {
      await define(h, name, method, { [field]: "${{ inputs.key }}" });
      const errors = errorsOf(await run(h, name, method, { key: h.canary }));
      assertEquals(errors.map((error) => error.code), [
        "method_execution_failed",
      ]);
      assertStringIncludes(errors[0].message, 'Invalid input at "token"');
      assertEquals(errors[0].message.includes("credential rejected"), false);
      assertEquals(errors[0].message.includes(made), false);
      assertEquals(errors[0].message.includes(h.canary), false);
      assertEquals(await swampFilesHolding(h.dir, made), []);
      assertEquals(await swampFilesHolding(h.dir, h.canary), []);
    }
    assertEquals(h.received, []);

    const step = await runStep(h, "refuse-made", "refuseMade", h.canary);
    assertEquals(step.status, "failed");
    assertStringIncludes(step.error, 'Invalid input at "token"');
    assertEquals(step.error.includes("credential rejected"), false);
    assertEquals(step.error.includes(made), false);
    assertEquals(step.record.includes(made), false);
    assertEquals(await swampFilesHolding(h.dir, made), []);
  });
});

Deno.test("input values: a schema transform that throws for a sensitive argument has its message withheld, so neither the value nor what was made of it reaches the error event or the failure record (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    const made = h.canary.toUpperCase();
    await define(h, "throw-made", "throwMade", { token: "${{ inputs.key }}" });
    const errors = errorsOf(
      await run(h, "throw-made", "throwMade", { key: h.canary }),
    );
    assertEquals(errors.map((error) => error.code), [
      "method_execution_failed",
    ]);
    assertStringIncludes(errors[0].message, "its message is withheld");
    assertEquals(errors[0].message.includes(made), false);
    assertEquals(errors[0].message.includes(h.canary), false);
    assertEquals(h.received, []);
    assertEquals(await swampFilesHolding(h.dir, made), []);
    assertEquals(await swampFilesHolding(h.dir, h.canary), []);
  });
});

Deno.test("input values: a method that echoes a key its schema's transform derived from an argument shows the mask in the error event, the failure record and a workflow step's error (swamp-club#3681)", async () => {
  await withHarness(async (h) => {
    const made = h.canary.toUpperCase();
    await define(h, "echo-made-keys", "failMadeKeys", {
      raw: "${{ inputs.key }}",
    });
    const errors = errorsOf(
      await run(h, "echo-made-keys", "failMadeKeys", { key: h.canary }),
    );
    assertEquals(h.received, [{ tokens: { [made]: null } }]);
    assertEquals(errors.map((error) => error.code), [
      "method_execution_failed",
    ]);
    assertEquals(errors[0].message, "intentional failure keys ***");
    assertEquals(await swampFilesHolding(h.dir, made), []);

    const step = await runStep(h, "echo-made-keys", "failMadeKeys", h.canary);
    assertEquals(step.status, "failed");
    assertStringIncludes(step.error, "intentional failure keys ***");
    assertEquals(step.error.includes(made), false);
    assertEquals(step.record.includes(made), false);
    assertEquals(await swampFilesHolding(h.dir, made), []);
  });
});
