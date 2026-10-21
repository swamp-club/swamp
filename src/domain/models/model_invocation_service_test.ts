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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import "../../domain/models/models.ts";
import type {
  InvocationTracking,
  MethodContext,
  ModelDefinition,
  RunModelResult,
} from "./model.ts";
import { defineModel, modelRegistry } from "./model.ts";
import type { MethodExecutionService } from "./method_execution_service.ts";
import type { CommonMethodContextDeps } from "./method_context.ts";
import {
  ModelInvocationService,
  type ModelInvocationServiceDeps,
} from "./model_invocation_service.ts";
import { ModelType } from "./model_type.ts";
import { Definition } from "../definitions/definition.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultService } from "../vaults/vault_service.ts";
import { SecretLoader } from "../vaults/secret_loader.ts";
import { SecretRedactor } from "../secrets/secret_redactor.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
} from "../vaults/run_vault_access.ts";
import { ExpressionEvaluationService } from "../expressions/expression_evaluation_service.ts";
import { DefaultMethodExecutionService } from "./method_execution_service.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { z } from "zod";
import { messageFor } from "../behavior_wording.ts";

await initializeLogging({});

type Evaluator = ModelInvocationServiceDeps["evaluationService"];
type RuntimeContext = Awaited<ReturnType<Evaluator["buildRuntimeContext"]>>;

// An evaluator for targets that hold no expressions: both passes return the
// definition as it is.
const passthroughEvaluator: Evaluator = {
  hasDefinitionExpressions: () => false,
  evaluateDefinition: () => {
    throw new Error("no expressions to evaluate");
  },
  buildRuntimeContext: () => Promise.resolve({} as RuntimeContext),
  resolveRuntimeExpressionsInDefinition: (definition) =>
    Promise.resolve({
      definition,
      secretBag: new VaultSecretBag(new SecretBagRegistry()),
    }),
  // Nothing is issued, so nothing is loaded.
  secretLoader: () =>
    new SecretLoader(() => Promise.resolve(new VaultService())),
};

function makeStubContext(
  overrides: Partial<MethodContext> = {},
): MethodContext {
  return {
    signal: AbortSignal.timeout(30_000),
    repoDir: "/tmp/test-repo",
    modelType: {
      normalized: "test/caller",
      raw: "test/caller",
    } as MethodContext["modelType"],
    modelId: "caller-def-id",
    globalArgs: {},
    definition: {
      id: "caller-def-id",
      name: "my-caller",
      version: 1,
      tags: {},
    },
    methodName: "invoke",
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as unknown as MethodContext["logger"],
    dataRepository: {} as MethodContext["dataRepository"],
    definitionRepository: {} as MethodContext["definitionRepository"],
    extensionFile: () => "",
    createCelEnvironment: () =>
      ({}) as ReturnType<MethodContext["createCelEnvironment"]>,
    ...overrides,
  };
}

function makeSvc(
  depOverrides: {
    definitionRepo?: Partial<CommonMethodContextDeps["definitionRepository"]>;
  } = {},
) {
  return new ModelInvocationService({
    executionService: {} as MethodExecutionService,
    commonDeps: {
      definitionRepository: {
        findByNameGlobal: () => Promise.resolve(null),
        findById: () => Promise.resolve(null),
        ...depOverrides.definitionRepo,
      },
    } as unknown as CommonMethodContextDeps,
    evaluationService: passthroughEvaluator,
    repoDir: "/tmp/test-repo",
  });
}

Deno.test("ModelInvocationService: rejects when depth limit exceeded", async () => {
  const svc = makeSvc();
  const tracking: InvocationTracking = {
    depth: 10,
    ancestors: new Set(),
    breadthCounter: { count: 0 },
  };

  const ctx = makeStubContext({ _invocationTracking: tracking });
  const result = await svc.invoke(
    { definition: "some-def", method: "read" },
    ctx,
  );

  assertEquals(result.ok, false);
  assertStringIncludes(
    (result as RunModelResult & { ok: false }).error.message,
    "Maximum cross-behavior invocation depth",
  );
});

Deno.test("ModelInvocationService: rejects when breadth limit exceeded", async () => {
  const svc = makeSvc();
  const tracking: InvocationTracking = {
    depth: 0,
    ancestors: new Set(),
    breadthCounter: { count: 100 },
  };

  const ctx = makeStubContext({ _invocationTracking: tracking });
  const result = await svc.invoke(
    { definition: "some-def", method: "read" },
    ctx,
  );

  assertEquals(result.ok, false);
  assertStringIncludes(
    (result as RunModelResult & { ok: false }).error.message,
    "Maximum cross-behavior invocation count",
  );
});

Deno.test("ModelInvocationService: breadth counter is shared across calls", async () => {
  const svc = makeSvc();
  const counter = { count: 98 };
  const tracking: InvocationTracking = {
    depth: 0,
    ancestors: new Set(),
    breadthCounter: counter,
  };

  const ctx = makeStubContext({ _invocationTracking: tracking });

  // count 98 -> 99 (under limit), fails on definition lookup
  await svc.invoke({ definition: "a", method: "read" }, ctx);
  assertEquals(counter.count, 99);

  // count 99 -> 100 (at limit but not over)
  await svc.invoke({ definition: "b", method: "read" }, ctx);
  assertEquals(counter.count, 100);

  // count 100 -> 101 (OVER limit)
  const result = await svc.invoke(
    { definition: "c", method: "read" },
    ctx,
  );
  assertEquals(result.ok, false);
  assertStringIncludes(
    (result as RunModelResult & { ok: false }).error.message,
    "Maximum cross-behavior invocation count",
  );
});

Deno.test("ModelInvocationService: returns error for nonexistent definition", async () => {
  const svc = makeSvc();
  const ctx = makeStubContext();
  const result = await svc.invoke(
    { definition: "does-not-exist", method: "greet" },
    ctx,
  );

  assertEquals(result.ok, false);
  const err = (result as RunModelResult & { ok: false }).error;
  assertStringIncludes(err.message, "does-not-exist");
  assertStringIncludes(err.message, "not found");
});

Deno.test("ModelInvocationService: initializes tracking when not present on context", async () => {
  const svc = makeSvc();
  const ctx = makeStubContext();
  assertEquals(ctx._invocationTracking, undefined);

  const result = await svc.invoke(
    { definition: "nonexistent", method: "read" },
    ctx,
  );

  // Should fail on lookup, not on tracking
  assertEquals(result.ok, false);
  assertStringIncludes(
    (result as RunModelResult & { ok: false }).error.message,
    "not found",
  );

  // Tracking must be persisted on the caller context so subsequent calls
  // share the same breadth counter
  assertEquals(ctx._invocationTracking !== undefined, true);
  assertEquals(ctx._invocationTracking!.breadthCounter.count, 1);
});

Deno.test("ModelInvocationService: breadth limit enforced from fresh context without pre-seeded tracking", async () => {
  const svc = makeSvc();
  const ctx = makeStubContext();

  for (let i = 0; i < 100; i++) {
    const result = await svc.invoke(
      { definition: `def-${i}`, method: "read" },
      ctx,
    );
    // Each call increments the counter and fails on definition lookup
    assertEquals(result.ok, false);
    assertStringIncludes(
      (result as RunModelResult & { ok: false }).error.message,
      "not found",
    );
  }

  // Call 101 must be refused by the breadth guard
  const result = await svc.invoke(
    { definition: "one-too-many", method: "read" },
    ctx,
  );
  assertEquals(result.ok, false);
  assertStringIncludes(
    (result as RunModelResult & { ok: false }).error.message,
    "Maximum cross-behavior invocation count",
  );
});

Deno.test("ModelInvocationService: depth 0 with no tracking allows first call", async () => {
  const svc = makeSvc();
  const ctx = makeStubContext();

  // No tracking = first call = depth 0. Should pass depth check
  // and fail on definition lookup instead.
  const result = await svc.invoke(
    { definition: "nonexistent", method: "read" },
    ctx,
  );

  assertEquals(result.ok, false);
  assertStringIncludes(
    (result as RunModelResult & { ok: false }).error.message,
    "not found",
  );
});

Deno.test("ModelInvocationService: depth 9 allows call (under limit of 10)", async () => {
  const svc = makeSvc();
  const tracking: InvocationTracking = {
    depth: 9,
    ancestors: new Set(),
    breadthCounter: { count: 0 },
  };

  const ctx = makeStubContext({ _invocationTracking: tracking });
  const result = await svc.invoke(
    { definition: "nonexistent", method: "read" },
    ctx,
  );

  // Should pass depth check (9 < 10) and fail on lookup
  assertEquals(result.ok, false);
  assertStringIncludes(
    (result as RunModelResult & { ok: false }).error.message,
    "not found",
  );
});

// ── Invocation provenance tests ──

const PROVENANCE_TARGET_TYPE = ModelType.create("test/provenance-target");
if (!modelRegistry.get(PROVENANCE_TARGET_TYPE)) {
  const targetModel: ModelDefinition = {
    type: PROVENANCE_TARGET_TYPE,
    version: "2026.07.11.1",
    methods: {
      greet: {
        description: "test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  defineModel(targetModel);
}

function makeProvenanceSvc(options: {
  captureContext: (ctx: MethodContext) => void;
  targetDefName: string;
  targetDef: Definition;
}) {
  const mockExecutionService: MethodExecutionService = {
    execute: () => Promise.resolve({ dataHandles: [] }),
    executeWorkflow: (_def, _modelDef, _method, ctx) => {
      options.captureContext(ctx);
      return Promise.resolve({ dataHandles: [] });
    },
  };

  const stubDataRepo = {
    findAllForModel: () => Promise.resolve([]),
    getContent: () => Promise.resolve(null),
  };

  return new ModelInvocationService({
    executionService: mockExecutionService,
    commonDeps: {
      dataRepository: stubDataRepo,
      definitionRepository: {
        findByNameGlobal: (name: string) => {
          if (name === options.targetDefName) {
            return Promise.resolve({
              definition: options.targetDef,
              type: PROVENANCE_TARGET_TYPE,
            });
          }
          return Promise.resolve(null);
        },
        findById: () => Promise.resolve(null),
      },
      createCelEnvironment: () =>
        ({}) as ReturnType<MethodContext["createCelEnvironment"]>,
    } as unknown as CommonMethodContextDeps,
    evaluationService: passthroughEvaluator,
    repoDir: "/tmp/test-repo",
  });
}

Deno.test("ModelInvocationService: sets _invocationProvenance on child context", async () => {
  let capturedContext: MethodContext | undefined;

  const targetDef = Definition.create({
    name: "target-def",
    type: "test/provenance-target",
    globalArguments: {},
  });

  const svc = makeProvenanceSvc({
    captureContext: (ctx) => {
      capturedContext = ctx;
    },
    targetDefName: "target-def",
    targetDef,
  });

  const callerCtx = makeStubContext({ _currentOutputId: "parent-output-123" });
  const result = await svc.invoke(
    { definition: "target-def", method: "greet" },
    callerCtx,
  );

  assertEquals(result.ok, true);
  assertEquals(capturedContext?._invocationProvenance?.triggeredBy, "model");
  assertEquals(
    capturedContext?._invocationProvenance?.parentOutputId,
    "parent-output-123",
  );
});

Deno.test("ModelInvocationService: parentOutputId is undefined when caller has no output", async () => {
  let capturedContext: MethodContext | undefined;

  const targetDef = Definition.create({
    name: "target-def-2",
    type: "test/provenance-target",
    globalArguments: {},
  });

  const svc = makeProvenanceSvc({
    captureContext: (ctx) => {
      capturedContext = ctx;
    },
    targetDefName: "target-def-2",
    targetDef,
  });

  const callerCtx = makeStubContext();
  const result = await svc.invoke(
    { definition: "target-def-2", method: "greet" },
    callerCtx,
  );

  assertEquals(result.ok, true);
  assertEquals(capturedContext?._invocationProvenance?.triggeredBy, "model");
  assertEquals(
    capturedContext?._invocationProvenance?.parentOutputId,
    undefined,
  );
});

// ── Argument routing tests ──

const ARG_ROUTING_TYPE = ModelType.create("test/arg-routing-target");
if (!modelRegistry.get(ARG_ROUTING_TYPE)) {
  const targetModel: ModelDefinition = {
    type: ARG_ROUTING_TYPE,
    version: "2026.07.11.1",
    globalArguments: z.object({
      region: z.string().default("us-east-1"),
    }),
    methods: {
      greet: {
        description: "test method with per-method args",
        arguments: z.object({
          name: z.string(),
        }),
        execute: (_args) => Promise.resolve({ dataHandles: [] }),
      },
      noargs: {
        description: "test method with no args",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  defineModel(targetModel);
}

function makeArgRoutingSvc(options: {
  captureDefinition: (def: Definition) => void;
  captureContext: (ctx: MethodContext) => void;
  targetDefName: string;
  targetDef: Definition;
  saveDefinition?: (type: unknown, def: Definition) => Promise<void>;
}) {
  const mockExecutionService: MethodExecutionService = {
    execute: () => Promise.resolve({ dataHandles: [] }),
    executeWorkflow: (def, _modelDef, _method, ctx) => {
      options.captureDefinition(def);
      options.captureContext(ctx);
      return Promise.resolve({ dataHandles: [] });
    },
  };

  const stubDataRepo = {
    findAllForModel: () => Promise.resolve([]),
    getContent: () => Promise.resolve(null),
  };

  return new ModelInvocationService({
    executionService: mockExecutionService,
    commonDeps: {
      dataRepository: stubDataRepo,
      definitionRepository: {
        findByNameGlobal: (name: string) => {
          if (name === options.targetDefName) {
            return Promise.resolve({
              definition: options.targetDef,
              type: ARG_ROUTING_TYPE,
            });
          }
          return Promise.resolve(null);
        },
        findById: () => Promise.resolve(null),
        save: options.saveDefinition ??
          (() => Promise.resolve()),
      },
      createCelEnvironment: () =>
        ({}) as ReturnType<MethodContext["createCelEnvironment"]>,
    } as unknown as CommonMethodContextDeps,
    evaluationService: passthroughEvaluator,
    repoDir: "/tmp/test-repo",
  });
}

Deno.test("ModelInvocationService: routes method args to child definition (by-definition)", async () => {
  let capturedDef: Definition | undefined;
  let capturedCtx: MethodContext | undefined;

  const targetDef = Definition.create({
    name: "routed-def",
    type: "test/arg-routing-target",
    globalArguments: { region: "eu-west-1" },
  });

  const svc = makeArgRoutingSvc({
    captureDefinition: (def) => {
      capturedDef = def;
    },
    captureContext: (ctx) => {
      capturedCtx = ctx;
    },
    targetDefName: "routed-def",
    targetDef,
  });

  const callerCtx = makeStubContext();
  const result = await svc.invoke(
    { definition: "routed-def", method: "greet", arguments: { name: "World" } },
    callerCtx,
  );

  assertEquals(result.ok, true);
  assertEquals(capturedDef!.getMethodArguments("greet"), { name: "World" });
  assertEquals(capturedCtx!.globalArgs, { region: "eu-west-1" });
});

Deno.test("ModelInvocationService: routes mixed global and method args (by-definition)", async () => {
  let capturedDef: Definition | undefined;
  let capturedCtx: MethodContext | undefined;

  const targetDef = Definition.create({
    name: "mixed-def",
    type: "test/arg-routing-target",
    globalArguments: { region: "us-east-1" },
  });

  const svc = makeArgRoutingSvc({
    captureDefinition: (def) => {
      capturedDef = def;
    },
    captureContext: (ctx) => {
      capturedCtx = ctx;
    },
    targetDefName: "mixed-def",
    targetDef,
  });

  const callerCtx = makeStubContext();
  const result = await svc.invoke(
    {
      definition: "mixed-def",
      method: "greet",
      arguments: { name: "World", region: "ap-south-1" },
    },
    callerCtx,
  );

  assertEquals(result.ok, true);
  assertEquals(capturedDef!.getMethodArguments("greet"), { name: "World" });
  assertEquals(capturedCtx!.globalArgs, { region: "ap-south-1" });
});

Deno.test("ModelInvocationService: unknown arguments return error", async () => {
  const targetDef = Definition.create({
    name: "unknown-def",
    type: "test/arg-routing-target",
    globalArguments: {},
  });

  const svc = makeArgRoutingSvc({
    captureDefinition: () => {},
    captureContext: () => {},
    targetDefName: "unknown-def",
    targetDef,
  });

  const callerCtx = makeStubContext();
  const result = await svc.invoke(
    {
      definition: "unknown-def",
      method: "greet",
      arguments: { bogus: "value" },
    },
    callerCtx,
  );

  assertEquals(result.ok, false);
  assertStringIncludes(
    (result as RunModelResult & { ok: false }).error.message,
    "Unknown argument(s): bogus",
  );
});

Deno.test("ModelInvocationService: no arguments preserves existing behavior", async () => {
  let capturedDef: Definition | undefined;
  let capturedCtx: MethodContext | undefined;

  const targetDef = Definition.create({
    name: "noargs-def",
    type: "test/arg-routing-target",
    globalArguments: { region: "us-west-2" },
  });

  const svc = makeArgRoutingSvc({
    captureDefinition: (def) => {
      capturedDef = def;
    },
    captureContext: (ctx) => {
      capturedCtx = ctx;
    },
    targetDefName: "noargs-def",
    targetDef,
  });

  const callerCtx = makeStubContext();
  const result = await svc.invoke(
    { definition: "noargs-def", method: "noargs" },
    callerCtx,
  );

  assertEquals(result.ok, true);
  assertEquals(capturedCtx!.globalArgs, { region: "us-west-2" });
  assertEquals(capturedDef!.getMethodArguments("noargs"), {});
});

Deno.test("ModelInvocationService: does not mutate original definition", async () => {
  const targetDef = Definition.create({
    name: "immutable-def",
    type: "test/arg-routing-target",
    globalArguments: { region: "eu-central-1" },
  });

  const svc = makeArgRoutingSvc({
    captureDefinition: () => {},
    captureContext: () => {},
    targetDefName: "immutable-def",
    targetDef,
  });

  const callerCtx = makeStubContext();
  await svc.invoke(
    {
      definition: "immutable-def",
      method: "greet",
      arguments: { name: "Test" },
    },
    callerCtx,
  );

  assertEquals(targetDef.getMethodArguments("greet"), {});
  assertEquals(targetDef.globalArguments, { region: "eu-central-1" });
});

Deno.test("ModelInvocationService: routes method args for by-type auto-creation", async () => {
  let capturedDef: Definition | undefined;
  let capturedCtx: MethodContext | undefined;
  let savedDef: Definition | undefined;

  const svc = makeArgRoutingSvc({
    captureDefinition: (def) => {
      capturedDef = def;
    },
    captureContext: (ctx) => {
      capturedCtx = ctx;
    },
    targetDefName: "__no_match__",
    targetDef: Definition.create({
      name: "unused",
      type: "test/arg-routing-target",
      globalArguments: {},
    }),
    saveDefinition: (_type, def) => {
      savedDef = def;
      return Promise.resolve();
    },
  });

  const callerCtx = makeStubContext();
  const result = await svc.invoke(
    {
      modelType: "test/arg-routing-target",
      name: "new-instance",
      method: "greet",
      arguments: { name: "World", region: "us-west-2" },
    },
    callerCtx,
  );

  assertEquals(result.ok, true);
  assertEquals(savedDef!.globalArguments, { region: "us-west-2" });
  assertEquals(capturedDef!.getMethodArguments("greet"), { name: "World" });
  assertEquals(capturedCtx!.globalArgs, { region: "us-west-2" });
});

Deno.test("ModelInvocationService: a missing method reads in behavior words, with the model spelling for swamp model", async () => {
  const svc = makeArgRoutingSvc({
    captureDefinition: () => {},
    captureContext: () => {},
    targetDefName: "__no_match__",
    targetDef: Definition.create({
      name: "unused",
      type: "test/arg-routing-target",
      globalArguments: {},
    }),
  });

  const result = await svc.invoke(
    {
      modelType: "test/arg-routing-target",
      name: "new-instance",
      method: "missing",
    },
    makeStubContext(),
  );

  assertEquals(result.ok, false);
  const error = (result as RunModelResult & { ok: false }).error;
  assertEquals(
    error.message,
    'Method "missing" not found on behavior type "test/arg-routing-target".',
  );
  assertEquals(
    messageFor(error, "model"),
    'Method "missing" not found on model type "test/arg-routing-target".',
  );
});

// ── z.record() argument routing tests ──

const RECORD_ROUTING_TYPE = ModelType.create("test/record-routing-target");
if (!modelRegistry.get(RECORD_ROUTING_TYPE)) {
  const recordModel: ModelDefinition = {
    type: RECORD_ROUTING_TYPE,
    version: "2026.07.24.1",
    globalArguments: z.object({
      baseUrl: z.string(),
      apiKey: z.string(),
    }),
    methods: {
      send: {
        description: "test method with z.record() args",
        arguments: z.record(z.string(), z.string()),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  defineModel(recordModel);
}

function makeRecordArgRoutingSvc(options: {
  captureDefinition: (def: Definition) => void;
  captureContext: (ctx: MethodContext) => void;
  targetDefName: string;
  targetDef: Definition;
}) {
  const mockExecutionService: MethodExecutionService = {
    execute: () => Promise.resolve({ dataHandles: [] }),
    executeWorkflow: (def, _modelDef, _method, ctx) => {
      options.captureDefinition(def);
      options.captureContext(ctx);
      return Promise.resolve({ dataHandles: [] });
    },
  };

  const stubDataRepo = {
    findAllForModel: () => Promise.resolve([]),
    getContent: () => Promise.resolve(null),
  };

  return new ModelInvocationService({
    executionService: mockExecutionService,
    commonDeps: {
      dataRepository: stubDataRepo,
      definitionRepository: {
        findByNameGlobal: (name: string) => {
          if (name === options.targetDefName) {
            return Promise.resolve({
              definition: options.targetDef,
              type: RECORD_ROUTING_TYPE,
            });
          }
          return Promise.resolve(null);
        },
        findById: () => Promise.resolve(null),
        save: () => Promise.resolve(),
      },
      createCelEnvironment: () =>
        ({}) as ReturnType<MethodContext["createCelEnvironment"]>,
    } as unknown as CommonMethodContextDeps,
    evaluationService: passthroughEvaluator,
    repoDir: "/tmp/test-repo",
  });
}

Deno.test("ModelInvocationService: z.record() method routes non-global keys to method args", async () => {
  let capturedDef: Definition | undefined;

  const targetDef = Definition.create({
    name: "record-def",
    type: "test/record-routing-target",
    globalArguments: { baseUrl: "https://example.com", apiKey: "key123" },
  });

  const svc = makeRecordArgRoutingSvc({
    captureDefinition: (def) => {
      capturedDef = def;
    },
    captureContext: () => {},
    targetDefName: "record-def",
    targetDef,
  });

  const callerCtx = makeStubContext();
  const result = await svc.invoke(
    {
      definition: "record-def",
      method: "send",
      arguments: { someKey: "someValue", other: "data" },
    },
    callerCtx,
  );

  assertEquals(result.ok, true);
  assertEquals(capturedDef!.getMethodArguments("send"), {
    someKey: "someValue",
    other: "data",
  });
});

// ── Expression resolution in the target definition (swamp-club#3227) ──

// A per-run type name, so repeats register afresh in the global registry.
const RESOLVE_TYPE = ModelType.create(
  `test/resolve-target-${crypto.randomUUID()}`,
);

interface ResolveCall {
  globalArgs: Record<string, unknown>;
  args: Record<string, unknown>;
  selfName: string;
}

const resolveCalls: ResolveCall[] = [];

defineModel({
  type: RESOLVE_TYPE,
  version: "2026.10.11.1",
  globalArguments: z.object({
    url: z.string(),
    label: z.string().optional(),
    token: z.string().meta({ sensitive: true }).optional(),
  }),
  methods: {
    show: {
      description: "records what it received",
      arguments: z.object({ note: z.string().optional() }),
      execute: (args, context) => {
        resolveCalls.push({
          globalArgs: { ...context.globalArgs },
          args: { ...(args as Record<string, unknown>) },
          selfName: context.definition.name,
        });
        return Promise.resolve({ dataHandles: [] });
      },
    },
    other: {
      description: "an unrelated method",
      arguments: z.object({ value: z.string().optional() }),
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
  },
});

async function withResolvingSvc(
  fn: (env: {
    svc: ModelInvocationService;
    definitionRepo: YamlDefinitionRepository;
    redactor: SecretRedactor;
    save: (def: Definition) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-invoke-resolve-" });
  try {
    const definitionRepo = new YamlDefinitionRepository(tempDir);
    const vaultService = new VaultService();
    vaultService.registerVault({ name: "v", type: "mock", config: {} });
    await vaultService.put("v", "api_url", "https://example.invalid");
    await vaultService.put("v", "token", "s3cret-token-value");
    const redactor = new SecretRedactor();
    const executionService = new DefaultMethodExecutionService();
    const svc = new ModelInvocationService({
      executionService,
      commonDeps: {
        dataRepository: {
          findAllForModel: () => Promise.resolve([]),
          getContent: () => Promise.resolve(null),
        },
        definitionRepository: definitionRepo,
        vaultService,
        createCelEnvironment: () =>
          ({}) as ReturnType<MethodContext["createCelEnvironment"]>,
      } as unknown as CommonMethodContextDeps,
      evaluationService: new ExpressionEvaluationService(
        definitionRepo,
        tempDir,
        { vaultService },
      ),
      repoDir: tempDir,
    });
    resolveCalls.length = 0;
    await fn({
      svc,
      definitionRepo,
      redactor,
      save: (def) => definitionRepo.save(RESOLVE_TYPE, def),
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

function errorOf(result: RunModelResult): string {
  return (result as RunModelResult & { ok: false }).error.message;
}

Deno.test("ModelInvocationService: target global arguments resolve vault.get and CEL on self", async () => {
  await withResolvingSvc(async ({ svc, save, redactor }) => {
    await save(Definition.create({
      name: "target-a",
      type: RESOLVE_TYPE.normalized,
      globalArguments: {
        url: "${{ vault.get(v, api_url) }}",
        label: '${{ "label-" + self.name }}',
        token: '${{ vault.get("v", "token") }}',
      },
    }));

    const result = await svc.invoke(
      { definition: "target-a", method: "show" },
      makeStubContext({ redactor }),
    );

    assertEquals(result.ok, true, result.ok ? "" : errorOf(result));
    assertEquals(resolveCalls.length, 1);
    assertEquals(resolveCalls[0].globalArgs, {
      url: "https://example.invalid",
      label: "label-target-a",
      token: "s3cret-token-value",
    });
    // The caller's redactor scrubs what the nested run resolved.
    assertEquals(
      redactor.redact("t=s3cret-token-value").includes("s3cret-token-value"),
      false,
    );
  });
});

Deno.test("ModelInvocationService: a vault.get in the target's method arguments resolves", async () => {
  await withResolvingSvc(async ({ svc, save }) => {
    const def = Definition.create({
      name: "target-m",
      type: RESOLVE_TYPE.normalized,
      globalArguments: { url: "https://plain.invalid" },
    });
    def.setMethodArgument("show", "note", '${{ vault.get("v", "api_url") }}');
    await save(def);

    const result = await svc.invoke(
      { definition: "target-m", method: "show" },
      makeStubContext(),
    );

    assertEquals(result.ok, true, result.ok ? "" : errorOf(result));
    assertEquals(resolveCalls[0].args, { note: "https://example.invalid" });
  });
});

Deno.test("ModelInvocationService: caller arguments arrive literally, never evaluated", async () => {
  await withResolvingSvc(async ({ svc, save }) => {
    const authored = '${{ "label-" + self.name }}';
    await save(Definition.create({
      name: "target-lit",
      type: RESOLVE_TYPE.normalized,
      globalArguments: { url: "https://plain.invalid", label: authored },
    }));

    for (
      const note of [
        '${{ vault.get("v", "token") }}',
        // The same text the target's author wrote is still the caller's.
        authored,
      ]
    ) {
      resolveCalls.length = 0;
      const result = await svc.invoke(
        { definition: "target-lit", method: "show", arguments: { note } },
        makeStubContext(),
      );
      assertEquals(result.ok, true, result.ok ? "" : errorOf(result));
      assertEquals(resolveCalls[0].args, { note });
      assertEquals(resolveCalls[0].globalArgs.label, "label-target-lit");
    }
  });
});

Deno.test("ModelInvocationService: refuses global arguments holding expression text swamp could evaluate", async () => {
  await withResolvingSvc(async ({ svc, save, definitionRepo }) => {
    await save(Definition.create({
      name: "target-ref",
      type: RESOLVE_TYPE.normalized,
      globalArguments: { url: "https://plain.invalid" },
    }));

    for (
      const url of [
        '${{ vault.get("v", "token") }}',
        "${{ env.HOME }}",
        '${{ file.contents("m", "f") }}',
        "${{ model.other.resource.x }}",
        '${{ data.latest("m", "d").attributes.x }}',
        "${{ self.name }}",
        "${{ inputs.region }}",
        "${{ inputs.?region }}",
        "${{ steps.build.outputs.sha }}",
        '${{ github.sha || data.latest("m", "d") }}',
        // Root-free text evaluates too, and would trip the execution guard.
        "${{ 1 }}",
        "x-${{ not valid cel !!! }}",
      ]
    ) {
      resolveCalls.length = 0;
      const byDefinition = await svc.invoke(
        { definition: "target-ref", method: "show", arguments: { url } },
        makeStubContext(),
      );
      assertEquals(byDefinition.ok, false, url);
      assertStringIncludes(errorOf(byDefinition), "Refusing to run");
      assertStringIncludes(
        errorOf(byDefinition),
        "Resolve the value in the calling method",
      );
      assertStringIncludes(
        errorOf(byDefinition),
        `url: ${url.slice(url.indexOf("${{"))}`,
      );

      const name = `auto-${crypto.randomUUID()}`;
      const byType = await svc.invoke(
        {
          modelType: RESOLVE_TYPE.normalized,
          name,
          method: "show",
          arguments: { url },
        },
        makeStubContext(),
      );
      assertEquals(byType.ok, false, url);
      assertEquals(await definitionRepo.findByNameGlobal(name), null, url);
      assertEquals(resolveCalls.length, 0, url);
    }
  });
});

Deno.test("ModelInvocationService: another templating system's text in a global argument arrives literally", async () => {
  await withResolvingSvc(async ({ svc, save }) => {
    await save(Definition.create({
      name: "target-gh",
      type: RESOLVE_TYPE.normalized,
      globalArguments: { url: "https://plain.invalid" },
    }));

    const url = "https://x.invalid/${{ github.sha }}";
    const result = await svc.invoke(
      { definition: "target-gh", method: "show", arguments: { url } },
      makeStubContext(),
    );

    assertEquals(result.ok, true, result.ok ? "" : errorOf(result));
    assertEquals(resolveCalls[0].globalArgs.url, url);
  });
});

Deno.test("ModelInvocationService: routed global arguments reach the method without changing the stored definition", async () => {
  await withResolvingSvc(async ({ svc, save, definitionRepo }) => {
    await save(Definition.create({
      name: "target-g",
      type: RESOLVE_TYPE.normalized,
      globalArguments: {
        url: "https://stored.invalid",
        label: '${{ "label-" + self.globalArguments.url }}',
      },
    }));

    const result = await svc.invoke(
      {
        definition: "target-g",
        method: "show",
        arguments: { url: "https://caller.invalid" },
      },
      makeStubContext(),
    );
    assertEquals(result.ok, true, result.ok ? "" : errorOf(result));
    // Set before evaluation, so self.globalArguments sees the caller's value.
    assertEquals(resolveCalls[0].globalArgs, {
      url: "https://caller.invalid",
      label: "label-https://caller.invalid",
    });

    // Type mode adopting the existing definition applies them the same way.
    const byType = await svc.invoke(
      {
        modelType: RESOLVE_TYPE.normalized,
        name: "target-g",
        method: "show",
        arguments: { url: "https://typed.invalid" },
      },
      makeStubContext(),
    );
    assertEquals(byType.ok, true, byType.ok ? "" : errorOf(byType));
    assertEquals(resolveCalls[1].globalArgs.url, "https://typed.invalid");

    const stored = await definitionRepo.findByNameGlobal("target-g");
    assertEquals(
      stored!.definition.globalArguments.url,
      "https://stored.invalid",
    );
  });
});

Deno.test("ModelInvocationService: a failed expression in the invoked method's arguments returns ok false", async () => {
  await withResolvingSvc(async ({ svc, save }) => {
    const def = Definition.create({
      name: "target-fail",
      type: RESOLVE_TYPE.normalized,
      globalArguments: { url: "https://plain.invalid" },
    });
    def.setMethodArgument("show", "note", "${{ self.nope.deeper }}");
    await save(def);

    const result = await svc.invoke(
      { definition: "target-fail", method: "show" },
      makeStubContext(),
    );
    assertEquals(result.ok, false);
    assertStringIncludes(errorOf(result), "note");
    assertEquals(resolveCalls.length, 0);

    // A caller argument replacing it wins, as an --input does on the CLI.
    const overridden = await svc.invoke(
      {
        definition: "target-fail",
        method: "show",
        arguments: { note: "replaced" },
      },
      makeStubContext(),
    );
    assertEquals(overridden.ok, true, overridden.ok ? "" : errorOf(overridden));
    assertEquals(resolveCalls[0].args, { note: "replaced" });
  });
});

Deno.test("ModelInvocationService: the caller's vault scope applies to the target's vault reads", async () => {
  await withResolvingSvc(async ({ svc, save }) => {
    await save(Definition.create({
      name: "target-scoped",
      type: RESOLVE_TYPE.normalized,
      globalArguments: { url: '${{ vault.get("v", "api_url") }}' },
    }));
    const unrelated = Definition.create({
      name: "target-unrelated",
      type: RESOLVE_TYPE.normalized,
      globalArguments: { url: "https://plain.invalid" },
    });
    unrelated.setMethodArgument(
      "other",
      "value",
      '${{ vault.get("v", "token") }}',
    );
    await save(unrelated);

    const access = RunVaultAccess.create({
      allowedVaults: ["some-other-vault"],
      allowListSource: "scoped-wf",
    });
    for (const definition of ["target-scoped", "target-unrelated"]) {
      const result = await runWithVaultAccess(
        access,
        () => svc.invoke({ definition, method: "show" }, makeStubContext()),
      );
      assertEquals(result.ok, false, definition);
      assertStringIncludes(errorOf(result), "Reading vault 'v' is refused");
    }
    assertEquals(resolveCalls.length, 0);
  });
});

Deno.test("ModelInvocationService: a target with no expressions runs with its stored arguments", async () => {
  await withResolvingSvc(async ({ svc, save }) => {
    await save(Definition.create({
      name: "target-plain",
      type: RESOLVE_TYPE.normalized,
      globalArguments: { url: "https://plain.invalid", label: "l" },
    }));

    const result = await svc.invoke(
      { definition: "target-plain", method: "show" },
      makeStubContext(),
    );
    assertEquals(result.ok, true, result.ok ? "" : errorOf(result));
    assertEquals(resolveCalls[0].globalArgs, {
      url: "https://plain.invalid",
      label: "l",
    });
  });
});

Deno.test("ModelInvocationService: a nested invocation runs on an independent registry that inherits the caller's typed-secrets option", async () => {
  for (const typed of [true, false, undefined]) {
    const callerRegistry = typed === undefined
      ? undefined
      : new SecretBagRegistry({ typedSecrets: typed });
    const callerBag = callerRegistry && new VaultSecretBag(callerRegistry);
    const callerSentinel = callerBag?.addSecret(
      { vaultName: "v", key: "k" },
      "methods.invoke.arguments.x",
    );
    const seen: SecretBagRegistry[] = [];
    const evaluator: Evaluator = {
      hasDefinitionExpressions: () => false,
      evaluateDefinition: () => {
        throw new Error("no expressions to evaluate");
      },
      buildRuntimeContext: (_definition, sensitiveValues) => {
        seen.push(sensitiveValues.sentinels);
        return Promise.resolve({} as RuntimeContext);
      },
      resolveRuntimeExpressionsInDefinition: (
        definition,
        _redactor,
        _context,
        _authored,
        options,
      ) => {
        seen.push(options!.secretBag!.registry);
        return Promise.resolve({ definition, secretBag: options!.secretBag! });
      },
      secretLoader: () =>
        new SecretLoader(() => Promise.resolve(new VaultService())),
    };
    let delivered: MethodContext | undefined;
    const targetDef = Definition.create({
      name: "typed-target",
      type: "test/provenance-target",
      globalArguments: {},
    });
    const svc = new ModelInvocationService({
      executionService: {
        execute: () => Promise.resolve({ dataHandles: [] }),
        executeWorkflow: (_def, _modelDef, _method, ctx) => {
          delivered = ctx;
          return Promise.resolve({ dataHandles: [] });
        },
      },
      commonDeps: {
        dataRepository: {
          findAllForModel: () => Promise.resolve([]),
          getContent: () => Promise.resolve(null),
        },
        definitionRepository: {
          findByNameGlobal: (name: string) =>
            Promise.resolve(
              name === "typed-target"
                ? { definition: targetDef, type: PROVENANCE_TARGET_TYPE }
                : null,
            ),
          findById: () => Promise.resolve(null),
        },
        createCelEnvironment: () =>
          ({}) as ReturnType<MethodContext["createCelEnvironment"]>,
      } as unknown as CommonMethodContextDeps,
      evaluationService: evaluator,
      repoDir: "/tmp/test-repo",
    });

    const result = await svc.invoke(
      { definition: "typed-target", method: "greet" },
      makeStubContext({ vaultSecrets: callerBag }),
    );
    assertEquals(result.ok, true, String(typed));

    // One registry for both passes and the delivery, and never the caller's.
    assertEquals(seen.length, 2, String(typed));
    const nested = seen[0];
    assertEquals(seen[1], nested);
    assertEquals(delivered?.vaultSecrets?.registry, nested);
    assertEquals(nested.typedSecrets, typed === true, String(typed));
    if (callerRegistry) {
      assertEquals(nested === callerRegistry, false);
      assertEquals(nested.isEmpty, true);
      assertEquals(nested.drewPrefixOf(callerSentinel!), false);
    }
  }
});
