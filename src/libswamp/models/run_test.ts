// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import {
  methodExecutionFailed,
  modelMethodRun,
  type ModelMethodRunDeps,
  type ModelMethodRunInput,
  modelNotFound,
  noEvaluatedDefinition,
  unknownMethod,
  unknownModelType,
} from "./run.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { z } from "zod";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";

await initializeLogging({});

// --- Test helpers ---

const TEST_MODEL_TYPE = ModelType.create("test/model");

function createTestDefinition(
  name: string,
  methodName: string,
): Definition {
  return Definition.create({
    name,
    methods: {
      [methodName]: {
        arguments: { key: "value" },
      },
    },
  });
}

function createTestModelDef(methodName: string): ModelDefinition {
  return {
    type: TEST_MODEL_TYPE,
    version: "1.0.0",
    methods: {
      [methodName]: {
        description: "Test method",
        arguments: z.object({
          key: z.string().optional(),
        }),
        execute: (_args, _ctx) => {
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  };
}

// deno-lint-ignore no-explicit-any
function createFakeOutputRepo(): any {
  return {
    save: () => Promise.resolve(),
    findById: () => Promise.resolve(null),
    findByDefinitionId: () => Promise.resolve([]),
    findByMethodName: () => Promise.resolve([]),
    findAll: () => Promise.resolve([]),
  };
}

// deno-lint-ignore no-explicit-any
function createFakeDataRepo(): any {
  return {
    nextId: () => crypto.randomUUID(),
    getPath: (
      _type: ModelType,
      _modelId: string,
      dataName: string,
      version: number,
    ) => `/data/${dataName}/v${version}`,
    getContent: () => Promise.resolve(null),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
  };
}

// deno-lint-ignore no-explicit-any
function createFakeDefinitionRepo(): any {
  return {
    findByNameGlobal: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    save: () => Promise.resolve(),
  };
}

// deno-lint-ignore no-explicit-any
function createFakeEvaluationService(): any {
  return {
    hasDefinitionExpressions: () => false,
    evaluateDefinition: (def: Definition) =>
      Promise.resolve({
        definition: def,
        type: TEST_MODEL_TYPE,
        hadExpressions: false,
      }),
    resolveRuntimeExpressionsInDefinition: (def: Definition) =>
      Promise.resolve({
        definition: def,
        secretBag: new VaultSecretBag(),
      }),
  };
}

// deno-lint-ignore no-explicit-any
function createFakeExecutionService(): any {
  return {
    executeWorkflow: () => Promise.resolve({ dataHandles: [] }),
  };
}

// deno-lint-ignore no-explicit-any
function createFakeVaultService(): any {
  return {};
}

// deno-lint-ignore no-explicit-any
function createFakeRedactor(): any {
  return {};
}

function createTestDeps(
  definition: Definition | null,
  modelDef: ModelDefinition | undefined,
): ModelMethodRunDeps {
  return {
    repoDir: "/tmp/test",
    lookupDefinition: (_idOrName) =>
      Promise.resolve(
        definition ? { definition, type: TEST_MODEL_TYPE } : null,
      ),
    getModelDef: (_type) => modelDef,
    createEvaluationService: () => createFakeEvaluationService(),
    loadEvaluatedDefinition: () => Promise.resolve(null),
    saveEvaluatedDefinition: () => Promise.resolve(),
    createExecutionService: () => createFakeExecutionService(),
    createVaultService: () => Promise.resolve(createFakeVaultService()),
    dataRepo: createFakeDataRepo(),
    definitionRepo: createFakeDefinitionRepo(),
    outputRepo: createFakeOutputRepo(),
    dataQueryService: {
      query: () => Promise.resolve([]),
    } as unknown as DataQueryService,
    createRunLog: () =>
      Promise.resolve({
        logFilePath: "/tmp/test.log",
        redactor: createFakeRedactor(),
        cleanup: () => {},
      }),
  };
}

function createTestInput(
  modelIdOrName: string,
  methodName: string,
): ModelMethodRunInput {
  return {
    modelIdOrName,
    methodName,
    inputs: {},
    lastEvaluated: false,
  };
}

// --- Tests ---

Deno.test("modelMethodRun yields validating_inputs and resolving_model prefix events", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);

  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  assertEquals(events[0].kind, "validating_inputs");
  assertEquals(events[1].kind, "resolving_model");
  if (events[1].kind === "resolving_model") {
    assertEquals(events[1].modelIdOrName, "test-model");
  }
});

Deno.test("modelMethodRun yields error for missing model", async () => {
  const deps = createTestDeps(null, undefined);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("nonexistent", "run")),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "model_not_found");
  }
});

Deno.test("modelMethodRun yields error for unknown model type", async () => {
  const definition = createTestDefinition("test-model", "run");
  const deps = createTestDeps(definition, undefined);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "unknown_model_type");
  }
});

Deno.test("modelMethodRun yields error for unknown method", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "nonexistent")),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "unknown_method");
  }
});

Deno.test("modelMethodRun yields error for missing evaluated definition with --last-evaluated", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, {
      ...createTestInput("test-model", "run"),
      lastEvaluated: true,
    }),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "no_evaluated_definition");
  }
});

Deno.test("modelMethodRun happy path yields model_resolved, evaluating, executing, completed", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds.includes("validating_inputs"), true);
  assertEquals(kinds.includes("resolving_model"), true);
  assertEquals(kinds.includes("model_resolved"), true);
  assertEquals(kinds.includes("evaluating_expressions"), true);
  assertEquals(kinds.includes("executing"), true);
  assertEquals(kinds.includes("completed"), true);

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.run.modelName, "test-model");
    assertEquals(completed.run.methodName, "run");
    assertEquals(completed.run.status, "succeeded");
    assertEquals(completed.run.modelType, "test/model");
  }
});

// deno-lint-ignore no-explicit-any
function createFailingExecutionService(error: Error): any {
  return { executeWorkflow: () => Promise.reject(error) };
}

Deno.test("modelMethodRun yields error on execution failure", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () =>
      createFailingExecutionService(new Error("execution boom")),
    outputRepo: createFakeOutputRepo(),
  };
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "method_execution_failed");
  }
});

Deno.test("modelMethodRun yields cancelled error on abort", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const controller = new AbortController();
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () =>
      createFailingExecutionService(
        new DOMException("The operation was aborted.", "AbortError"),
      ),
    outputRepo: createFakeOutputRepo(),
  };

  // Abort before execution to simulate cancellation
  controller.abort();
  const ctx = createLibSwampContext({ signal: controller.signal });
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "cancelled");
  }
});

// --- Error factory tests ---

Deno.test("modelNotFound returns correct error", () => {
  const error = modelNotFound("my-model");
  assertEquals(error.code, "model_not_found");
  assertEquals(error.message, "Model not found: my-model");
});

Deno.test("unknownModelType returns correct error", () => {
  const error = unknownModelType("bad/type");
  assertEquals(error.code, "unknown_model_type");
  assertEquals(error.message, "Unknown model type: bad/type");
});

Deno.test("unknownMethod returns correct error", () => {
  const error = unknownMethod("bad", "test/model", "run, create");
  assertEquals(error.code, "unknown_method");
  assertEquals(
    error.message,
    "Unknown method 'bad' for type 'test/model'. Available methods: run, create",
  );
});

Deno.test("noEvaluatedDefinition returns correct error", () => {
  const error = noEvaluatedDefinition("my-model");
  assertEquals(error.code, "no_evaluated_definition");
  assertEquals(
    error.message.includes("my-model"),
    true,
  );
});

Deno.test("methodExecutionFailed wraps error", () => {
  const error = methodExecutionFailed(new Error("boom"));
  assertEquals(error.code, "method_execution_failed");
  assertEquals(error.message, "boom");
  assertEquals(error.cause?.message, "boom");
});
