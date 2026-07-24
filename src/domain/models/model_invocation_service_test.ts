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
import { ModelInvocationService } from "./model_invocation_service.ts";
import { ModelType } from "./model_type.ts";
import { Definition } from "../definitions/definition.ts";
import { z } from "zod";

await initializeLogging({});

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
    "Maximum cross-model invocation depth",
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
    "Maximum cross-model invocation count",
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
    "Maximum cross-model invocation count",
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
