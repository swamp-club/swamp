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
 * The evaluated-definition cache on the real repository, for a sensitive
 * argument whose value came from the run's inputs rather than a vault
 * (swamp-club#3681): the domain builds the persisted form, the repository
 * writes it, and the file holds the mask beside the vault reference of the
 * value that did come from a vault. Read back, the replay predicate names
 * the masked path, the vault value still rehydrates, and a write that skips
 * the domain builder is refused at the repository.
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { UserError } from "../src/domain/errors.ts";
import {
  RunSensitiveValues,
  vaultReferenceText,
} from "../src/domain/secrets/mod.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import {
  findPlaintextSensitiveArguments,
  persistEvaluatedDefinition,
  rehydrateEvaluatedDefinition,
} from "../src/domain/expressions/persisted_evaluation.ts";
import {
  keyPath,
  ProvenanceMap,
} from "../src/domain/expressions/provenance_map.ts";
import { deferredExpressionReference } from "../src/domain/expressions/deferred_expression.ts";
import { YamlEvaluatedDefinitionRepository } from "../src/infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createModelMethodRunDeps } from "../src/serve/deps.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const INPUT_VALUE = "REPRO-SECRET-7c1e";
const VAULT_VALUE = "VAULT-CTRL-9a9a";
const SOURCE = { vaultName: "prod", key: "api-token" };

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-evaluated-cache-" });
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

/** A type with two sensitive globals and one sensitive method argument. */
function registerType(): ModelType {
  const type = ModelType.create(
    `@test/sensitive-global-arg-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type,
    version: "2026.05.29.1",
    globalArguments: z.object({
      apiKey: z.string().meta({ sensitive: true }),
      token: z.string().meta({ sensitive: true }),
      region: z.string(),
    }),
    methods: {
      execute: {
        description: "Uses the key",
        arguments: z.object({
          secret: z.string().meta({ sensitive: true }).optional(),
        }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  });
  return type;
}

async function filesHolding(dir: string, text: string): Promise<string[]> {
  const hits: string[] = [];
  for await (const entry of walk(dir, { includeDirs: false })) {
    if ((await Deno.readTextFile(entry.path)).includes(text)) {
      hits.push(entry.path);
    }
  }
  return hits;
}

Deno.test("evaluated cache: an input-fed sensitive argument is written as the mask beside a vault reference, reads back as not replayable, and the vault value still rehydrates (swamp-club#3681)", async () => {
  await withTempDir(async (dir) => {
    const type = registerType();
    try {
      const modelDef = modelRegistry.get(type);
      if (!modelDef) throw new Error("type not registered");
      const values = new RunSensitiveValues();
      const bag = new VaultSecretBag(values.sentinels);
      const sentinel = bag.addDataSecret(VAULT_VALUE, SOURCE);
      // The copy that executes: the input value in clear, the vault value as
      // the sentinel its sensitive data read issued.
      const executed = Definition.create({
        name: "input-svc",
        type: type.normalized,
        globalArguments: {
          apiKey: INPUT_VALUE,
          token: sentinel,
          region: "eu-west-1",
        },
        methods: { execute: { arguments: { secret: INPUT_VALUE } } },
      });
      const source = Definition.fromData({
        ...executed.toData(),
        globalArguments: {
          apiKey: "${{ inputs.key }}",
          token: "${{ data.latest('db', 'creds').attributes.token }}",
          region: "eu-west-1",
        },
        methods: { execute: { arguments: { secret: "${{ inputs.key }}" } } },
      });
      const persisted = persistEvaluatedDefinition(
        executed,
        [],
        source,
        values,
        modelDef,
      );
      const repo = new YamlEvaluatedDefinitionRepository(dir);
      await repo.save(
        type,
        persisted.definition,
        ProvenanceMap.authored(),
        new Set(["${{ inputs.key }}"]),
        persisted.deferredExpressions,
        persisted.writtenReferences,
        persisted.maskedPaths,
        persisted.persistedProvenance,
      );

      assertEquals(await filesHolding(dir, INPUT_VALUE), []);
      assertEquals(await filesHolding(dir, VAULT_VALUE), []);

      const cached = await repo.findByNameWithProvenance(type, "input-svc");
      if (!cached) throw new Error("evaluated definition not found");
      assertEquals(cached.persistedProvenance === "unreadable", false);
      assertEquals(
        cached.persistedProvenance &&
          cached.persistedProvenance !== "unreadable"
          ? cached.persistedProvenance.toData()
          : undefined,
        persisted.persistedProvenance.toData(),
      );
      assertEquals(cached.definition.globalArguments, {
        apiKey: "***",
        token: vaultReferenceText(SOURCE),
        region: "eu-west-1",
      });
      assertEquals(cached.definition.getMethodArguments("execute"), {
        secret: "***",
      });
      assertEquals(
        findPlaintextSensitiveArguments(
          modelDef,
          cached.definition.toData(),
          cached.writtenReferences,
        ),
        ["globalArguments.apiKey", "methods.execute.arguments.secret"],
      );
      // The file records the masked positions, and they alone refuse a
      // replay under a type that no longer marks the fields.
      assertEquals(cached.maskedPaths, [
        ["globalArguments", "apiKey"],
        ["methods", "execute", "arguments", "secret"],
      ]);
      assertEquals(
        findPlaintextSensitiveArguments(
          { methods: {} },
          cached.definition.toData(),
          cached.writtenReferences,
          { recordedMasks: cached.maskedPaths },
        ),
        ["globalArguments.apiKey", "methods.execute.arguments.secret"],
      );

      const replayValues = new RunSensitiveValues();
      const stepBag = new VaultSecretBag(replayValues.sentinels);
      const restored = await rehydrateEvaluatedDefinition(cached, stepBag);
      assertEquals(
        stepBag.registry.issuedEntryOf(
          restored.definition.globalArguments.token as string,
        )?.reference,
        SOURCE,
      );
      assertEquals(replayValues.list(), []);
      assertEquals(restored.definition.globalArguments.apiKey, "***");

      // A write that skips persistEvaluatedDefinition is refused at the
      // repository and leaves no file.
      const leaky = Definition.create({
        name: "leaky",
        type: type.normalized,
        globalArguments: { apiKey: INPUT_VALUE, token: "", region: "eu" },
      });
      const error = await assertRejects(
        () => repo.save(type, leaky, ProvenanceMap.authored()),
        UserError,
      );
      assertStringIncludes(error.message, "'globalArguments.apiKey'");
      assertEquals(error.message.includes(INPUT_VALUE), false);
      assertEquals(await repo.findByName(type, "leaky"), null);
      assertEquals(await filesHolding(dir, INPUT_VALUE), []);
      for (
        const apiKey of ["${{ env.TOKEN }}", `${INPUT_VALUE}\${{ env.TOKEN }}`]
      ) {
        const bypass = Definition.create({
          name: "bypass",
          type: type.normalized,
          globalArguments: { apiKey, token: "", region: "eu" },
        });
        await assertRejects(
          () =>
            repo.save(
              type,
              bypass,
              ProvenanceMap.authored().withWholeData("globalArguments.apiKey"),
            ),
          UserError,
        );
        assertEquals(await repo.findByName(type, "bypass"), null);
      }
      const mixedReference = Definition.create({
        name: "mixed-reference",
        globalArguments: {
          apiKey: `${INPUT_VALUE}${vaultReferenceText(SOURCE)}`,
          token: "",
          region: "eu",
        },
      });
      await assertRejects(
        () =>
          repo.save(
            type,
            mixedReference,
            ProvenanceMap.authored().withRanges("globalArguments.apiKey", [[
              0,
              INPUT_VALUE.length,
            ]]),
            undefined,
            [],
            [{
              path: ["globalArguments", "apiKey"],
              occurrence: 0,
              ...SOURCE,
              encoding: "raw",
              dataOrigin: true,
            }],
          ),
        UserError,
      );
      assertEquals(await repo.findByName(type, "mixed-reference"), null);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("evaluated cache: sensitive input keys do not survive in values, provenance, or refusal paths", async () => {
  await withTempDir(async (dir) => {
    const type = ModelType.create(
      `@test/container-keys-${crypto.randomUUID()}`,
    );
    const schemas = {
      globalArguments: z.object({
        creds: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
      }),
      methods: {},
    };
    modelRegistry.register({ type, version: "2026.01.01.1", ...schemas });
    try {
      const executed = Definition.create({
        name: "key-svc",
        type: type.normalized,
        globalArguments: {
          creds: { [INPUT_VALUE]: "${{ vault.get('prod', 'value') }}" },
        },
      });
      const provenance = ProvenanceMap.authored().withWholeData(
        keyPath("globalArguments.creds", INPUT_VALUE),
      );
      const persisted = persistEvaluatedDefinition(
        executed,
        [{
          id: crypto.randomUUID(),
          expression: "${{ env.NOTE }}",
          bindings: { inputs: { creds: { [INPUT_VALUE]: true } } },
          provenance: ProvenanceMap.authored().withWholeData(
            keyPath("inputs.creds", INPUT_VALUE),
          ).toData(),
        }],
        executed,
        new RunSensitiveValues(),
        schemas,
        provenance,
      );
      assertEquals(persisted.definition.globalArguments, { creds: "***" });
      assertEquals(persisted.maskedPaths, [["globalArguments", "creds"]]);
      const repo = new YamlEvaluatedDefinitionRepository(dir);
      await repo.save(
        type,
        persisted.definition,
        provenance,
        undefined,
        persisted.deferredExpressions,
        persisted.writtenReferences,
        persisted.maskedPaths,
        persisted.persistedProvenance,
      );
      assertEquals(await filesHolding(dir, INPUT_VALUE), []);
      const cache = await repo.findByNameWithProvenance(type, executed.name);
      assertExists(cache);
      assertEquals(
        findPlaintextSensitiveArguments(
          schemas,
          cache.definition.toData(),
          cache.writtenReferences,
          {
            recordedMasks: cache.maskedPaths,
          },
        ),
        ["globalArguments.creds"],
      );
      const error = await assertRejects(
        () => repo.save(type, executed, provenance),
        UserError,
      );
      assertEquals(error.message.includes(INPUT_VALUE), false);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

for (
  const target of [
    "global",
    "method",
    "accepted-alias",
    "direct",
    "mixed",
    "literal-expression",
    "fallback",
    "nested",
    "nested-direct",
    "nested-expression",
  ] as const
) {
  Deno.test(`evaluated cache: workflow ${target} arguments consume mapped step inputs without persisting forwarded copies (swamp-club#3681)`, async () => {
    const direct = target === "direct" || target === "nested-direct";
    const deferredNote = target === "nested" || target === "nested-direct";
    const verify = async (dir: string) => {
      const inputValue = target === "literal-expression"
        ? "INPUT-CANARY${{ env.SUFFIX }}"
        : INPUT_VALUE;
      const type = ModelType.create(
        `@test/step-input-${crypto.randomUUID()}`,
      );
      const received: { globalArgs: unknown; args: unknown }[] = [];
      modelRegistry.register({
        type,
        version: "2026.01.01.1",
        globalArguments: z.object({
          apiKey: z.string().meta({ sensitive: true }).optional(),
          region: z.string(),
          token: z.string().optional(),
        }),
        methods: {
          execute: {
            description: "Records arguments received by the method",
            arguments: z.object({
              token: z.string().meta({ sensitive: true }).optional(),
              note: z.string(),
              ...(target === "accepted-alias" ? { tok: z.string() } : {}),
            }),
            execute: (args, context) => {
              received.push({ globalArgs: context.globalArgs, args });
              return Promise.resolve({});
            },
          },
        },
      });
      const catalog = new CatalogStore(join(dir, "_catalog.db"));
      try {
        const inputKey = target === "global" ? "key" : direct ? "token" : "tok";
        const expression = `\${{ inputs.${inputKey} }}${
          target === "mixed" ? "${{ env.SUFFIX }}" : ""
        }`;
        const definition = Definition.create({
          name: `svc-${target}`,
          type: type.normalized,
          inputs: target === "accepted-alias" ? undefined : {
            properties: { [inputKey]: { type: "string" } },
            required: [inputKey],
          },
          globalArguments: {
            region: "eu-west-1",
            ...(target === "global" ? { apiKey: expression } : {}),
            ...(target === "fallback" ? { token: expression } : {}),
          },
          methods: {
            execute: {
              arguments: {
                note: "source-note",
                ...(target === "global" || target === "fallback"
                  ? {}
                  : { token: expression }),
              },
            },
          },
        });
        await new YamlDefinitionRepository(dir).save(type, definition);
        const workflow = Workflow.create({
          name: `wf-${target}`,
          inputs: {
            properties: {
              secret: { type: "string" },
              suffix: { type: "string" },
            },
            required: ["secret"],
          },
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "call",
              task: StepTask.model(definition.name, "execute", {
                [inputKey]: "${{ inputs.secret }}",
                undeclared: "${{ inputs.secret }}",
                note: deferredNote ? "${{ inputs.suffix }}" : "step-note",
              }),
            })],
          })],
        });
        const workflowRepo = new YamlWorkflowRepository(dir);
        await workflowRepo.save(workflow);
        let entrypoint = workflow.name;
        if (target.startsWith("nested")) {
          const parent = Workflow.create({
            name: `parent-${target}`,
            inputs: {
              properties: { secret: { type: "string" } },
              required: ["secret"],
            },
            jobs: [
              Job.create({
                name: "parent",
                steps: [
                  Step.create({
                    name: "child",
                    task: StepTask.workflow(workflow.name, {
                      secret: target === "nested-expression"
                        ? "${{ env.SUFFIX + inputs.secret }}"
                        : "${{ inputs.secret }}",
                      suffix: "${{ env.SUFFIX }}",
                    }),
                  }),
                ],
              }),
            ],
          });
          await workflowRepo.save(parent);
          entrypoint = parent.name;
        }
        const runRepo = new YamlWorkflowRunRepository(dir);
        const service = new WorkflowExecutionService(
          workflowRepo,
          runRepo,
          dir,
          undefined,
          undefined,
          catalog,
        );
        const run = await service.execute(entrypoint, {
          inputs: { secret: inputValue },
        });
        assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
        const expected = {
          globalArgs: {
            region: "eu-west-1",
            ...(target === "global" ? { apiKey: inputValue } : {}),
            ...(target === "fallback" ? { token: inputValue } : {}),
          },
          args: {
            note: deferredNote ? "-suffix" : "step-note",
            ...(target === "accepted-alias" ? { tok: inputValue } : {}),
            ...(target === "global" ? {} : {
              token: (target === "nested-expression" ? "-suffix" : "") +
                inputValue + (target === "mixed" ? "-suffix" : ""),
            }),
          },
        };
        assertEquals(received, [expected]);
        const evaluatedRepo = new YamlEvaluatedDefinitionRepository(dir);
        const cache = await evaluatedRepo.findByNameWithProvenance(
          type,
          definition.name,
        );
        assertExists(cache);
        assertEquals(
          await filesHolding(
            join(dir, ".swamp", "definitions-evaluated"),
            inputValue,
          ),
          [],
        );
        assertEquals(cache.definition.getMethodArguments("execute"), {
          ...(target === "accepted-alias" ? { tok: "***" } : {}),
          note: deferredNote
            ? deferredExpressionReference(cache.deferredExpressions[0].id)
            : "step-note",
          ...(target === "global" || target === "fallback"
            ? {}
            : { token: "***" }),
        });
        const maskedPath = target === "global"
          ? ["globalArguments", "apiKey"]
          : target === "fallback"
          ? ["globalArguments", "token"]
          : ["methods", "execute", "arguments", "token"];
        assertEquals(cache.maskedPaths[0], maskedPath);
        if (target.startsWith("nested")) {
          assertEquals(cache.deferredExpressions.length > 0, true);
          for (const record of cache.deferredExpressions) {
            assertEquals(
              Object.keys(record.bindings).filter((key) =>
                key !== "workflowRunId"
              ),
              [],
            );
          }
          assertEquals(
            cache.maskedPaths.some((path) => path[0] === "deferredExpressions"),
            target === "nested-expression",
          );
        } else {
          assertEquals(
            cache.maskedPaths,
            target === "accepted-alias"
              ? [maskedPath, ["methods", "execute", "arguments", "tok"]]
              : [maskedPath],
          );
        }

        const replay = await service.execute(workflow.name, {
          lastEvaluated: true,
        });
        // --last-evaluated replays the workflow's pinned inputs, then
        // evaluates its definition again; it does not read the masked cache.
        assertEquals(
          replay.status,
          "succeeded",
          JSON.stringify(replay.toData()),
        );
        assertEquals(received, [expected, expected]);
        assertEquals(
          await filesHolding(
            join(dir, ".swamp", "definitions-evaluated"),
            inputValue,
          ),
          [],
        );
      } finally {
        catalog.close();
        modelRegistry.invalidateType(type);
      }
    };
    await withMockedEnv({ SUFFIX: "-suffix" }, () => withTempDir(verify));
  });
}

for (
  const [name, schema] of [
    [
      "union",
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("one"), target: z.string() }),
        z.object({ kind: z.literal("two"), other: z.string() }),
      ]),
    ],
    ["catchall", z.object({ kind: z.literal("one") }).catchall(z.string())],
    [
      "intersection",
      z.intersection(
        z.object({ kind: z.literal("one") }),
        z.object({ target: z.string() }),
      ),
    ],
    [
      "declared-input",
      z.object({ kind: z.literal("one"), target: z.string() }),
    ],
    ["custom", z.custom<Record<string, unknown>>()],
    [
      "transformed-global",
      z.object({ target: z.string().meta({ sensitive: true }).optional() }),
    ],
    [
      "masked-discriminator",
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("one").meta({ sensitive: true }),
          target: z.string(),
        }),
        z.object({
          kind: z.literal("two"),
          target: z.string().meta({ sensitive: true }),
        }),
      ]),
    ],
    [
      "sensitive-preprocess",
      z.preprocess((value) => {
        const input = value as Record<string, unknown>;
        return { target: input.alias };
      }, z.object({ target: z.string().meta({ sensitive: true }).optional() })),
    ],
    [
      "preprocess-keys",
      z.preprocess(
        (value) => ({ target: Object.keys(value as object)[0] }),
        z.object({ target: z.string().meta({ sensitive: true }).optional() }),
      ),
    ],
    [
      "preprocess",
      z.preprocess((value) => {
        if (typeof value !== "object" || value === null) return value;
        const input = value as Record<string, unknown>;
        return { ...input, target: input.alias ?? input.target };
      }, z.object({ kind: z.literal("one"), target: z.string() })),
    ],
  ] as const
) {
  Deno.test(`evaluated cache: ${name} method overrides preserve safe replay behavior`, async () => {
    // A step input the workflow spells is the author's own text, so a
    // preprocessor that reads its keys caches and replays them
    // (swamp-club#3681); only data at such a position is masked.
    const opaque = name === "sensitive-preprocess" ||
      name === "transformed-global";
    await withTempDir(async (dir) => {
      const repo = createRepositoryContext({ repoDir: dir });
      const type = ModelType.create(
        `@test/cache-schema-${crypto.randomUUID()}`,
      );
      const received: unknown[] = [];
      modelRegistry.register({
        type,
        version: "2026.01.01.1",
        ...(name === "transformed-global"
          ? {
            globalArguments: z.object({ alias: z.string() }).transform((
              { alias },
            ) => ({ target: alias })),
          }
          : {}),
        methods: {
          execute: {
            description: "Captures arguments",
            arguments: schema,
            execute: (args) => {
              received.push(args);
              return Promise.resolve({});
            },
          },
        },
      });
      try {
        const definition = Definition.create({
          name: "consumer",
          type: type.normalized,
          ...(name === "transformed-global"
            ? { globalArguments: { alias: "${{ inputs.value }}" } }
            : {}),
          ...(name === "declared-input"
            ? {
              inputs: { properties: { target: { type: "string" as const } } },
            }
            : {}),
          methods: {
            execute: {
              // Both sensitive preprocessors read only what the step
              // supplies (its `alias`, or its first key), and the
              // transformed global feeds the method from the globals, so
              // their definitions spell no arguments of their own.
              arguments: opaque || name === "preprocess-keys" ? {} : {
                kind: "one",
                ...(name === "catchall" ? {} : { target: "old" }),
              },
            },
          },
        });
        await repo.definitionRepo.save(type, definition);
        const workflow = Workflow.create({
          name: "override",
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "call",
                  task: StepTask.model(
                    definition.name,
                    "execute",
                    name === "transformed-global" ? {} : {
                      [
                        name === "preprocess-keys"
                          ? INPUT_VALUE
                          : name.endsWith("preprocess")
                          ? "alias"
                          : "target"
                      ]: name === "preprocess-keys"
                        ? null
                        : "${{ inputs.value }}",
                    },
                  ),
                }),
              ],
            }),
          ],
        });
        await repo.workflowRepo.save(workflow);
        const service = new WorkflowExecutionService(
          repo.workflowRepo,
          repo.workflowRunRepo,
          dir,
          undefined,
          undefined,
          repo.catalogStore,
        );
        const run = await service.execute(workflow.name, {
          inputs: {
            value: opaque ? INPUT_VALUE : "new",
          },
        });
        assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
        const deps = await createModelMethodRunDeps(dir, repo);
        const events = await collect(
          modelMethodRun(createLibSwampContext(), deps, {
            modelIdOrName: definition.name,
            methodName: "execute",
            inputs: {},
            lastEvaluated: true,
          }),
        );
        if (
          opaque || name === "masked-discriminator"
        ) {
          assertEquals(
            events.filter((event) => event.kind === "error").map((event) =>
              event.error.code
            ),
            ["evaluated_cache_holds_sensitive_arguments"],
          );
          assertEquals(
            await filesHolding(
              join(dir, ".swamp", "definitions-evaluated"),
              INPUT_VALUE,
            ),
            [],
          );
          const expected = name === "masked-discriminator"
            ? { kind: "one", target: "new" }
            : { target: INPUT_VALUE };
          assertEquals(received, [expected]);
          const replay = await service.execute(workflow.name, {
            lastEvaluated: true,
          });
          assertEquals(
            replay.status,
            "succeeded",
            JSON.stringify(replay.toData()),
          );
          assertEquals(received, [expected, expected]);
        } else {
          assertEquals(events.filter((event) => event.kind === "error"), []);
          const expected = name === "preprocess-keys"
            ? { target: INPUT_VALUE }
            : { kind: "one", target: "new" };
          assertEquals(received, [expected, expected]);
        }
      } finally {
        repo.catalogStore.close();
        modelRegistry.invalidateType(type);
      }
    });
  });
}
