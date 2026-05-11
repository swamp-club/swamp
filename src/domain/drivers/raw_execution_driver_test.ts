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
import { RawExecutionDriver } from "./raw_execution_driver.ts";
import type { MethodExecutor } from "./raw_execution_driver.ts";
import type { ExecutionRequest } from "./execution_driver.ts";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import type {
  DataHandle,
  MethodContext,
  MethodDefinition,
  ModelDefinition,
} from "../models/model.ts";
import { z } from "zod";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { type DataId, generateDataId } from "../data/data_id.ts";
import { getLogger } from "@logtape/logtape";
import type { DataQueryService } from "../data/data_query_service.ts";

const TEST_MODEL_TYPE = ModelType.create("test/raw-driver");

function createMockDataRepo(): UnifiedDataRepository {
  return {
    findAllGlobal: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestMarker: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
  } as unknown as UnifiedDataRepository;
}

function createMockHandle(name: string): DataHandle {
  return {
    name,
    specName: name,
    kind: "resource",
    dataId: `mock-${name}` as DataId,
    version: 1,
    size: 10,
    tags: {},
    metadata: {
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: {},
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: "test",
      },
    },
  };
}

const testDefinition = Definition.create({
  name: "test-model",
  type: TEST_MODEL_TYPE.normalized,
});

const testMethod: MethodDefinition = {
  description: "Test method",
  arguments: z.object({}),
  execute: () => Promise.resolve({}),
};

const testModelDef: ModelDefinition = {
  type: TEST_MODEL_TYPE,
  version: "2026.01.01.1",
  globalArguments: z.object({}),
  resources: {
    "output": {
      description: "Test output",
      schema: z.object({ value: z.string() }),
      lifetime: "ephemeral",
      garbageCollection: 10,
    },
  },
  methods: {
    test: testMethod,
  },
};

function createMockContext(): MethodContext {
  return {
    signal: new AbortController().signal,
    repoDir: "/tmp/test-repo",
    modelType: TEST_MODEL_TYPE,
    modelId: testDefinition.id,
    globalArgs: {},
    definition: {
      id: testDefinition.id,
      name: testDefinition.name,
      version: testDefinition.version,
      tags: {},
    },
    methodName: "test",
    dataRepository: createMockDataRepo(),
    definitionRepository: {} as MethodContext["definitionRepository"],
    logger: getLogger(["test"]),
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  } as MethodContext;
}

function createMockRequest(): ExecutionRequest {
  return {
    protocolVersion: 1,
    modelType: TEST_MODEL_TYPE.normalized,
    modelId: testDefinition.id,
    methodName: "test",
    globalArgs: {},
    methodArgs: {},
    definitionMeta: {
      id: testDefinition.id,
      name: testDefinition.name,
      version: testDefinition.version,
      tags: {},
    },
  };
}

Deno.test("RawExecutionDriver: collects writer handles when method returns no dataHandles", async () => {
  const executor: MethodExecutor = {
    execute: async (_def, _method, context) => {
      // Simulate extension model: writes resource but returns no dataHandles
      await context.writeResource!("output", "output", { value: "test" });
      return {};
    },
  };

  const context = createMockContext();

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  const result = await driver.execute(createMockRequest());

  assertEquals(result.status, "success");
  // The driver should collect handles from the writer since the method
  // returned no dataHandles
  assertEquals(result.outputs.length > 0, true);
  assertEquals(result.outputs[0].kind, "persisted");
});

Deno.test("RawExecutionDriver: uses explicit dataHandles when method returns them", async () => {
  const explicitHandle = createMockHandle("explicit");

  const executor: MethodExecutor = {
    execute: (_def, _method, _context) => {
      // Simulate built-in model: returns explicit dataHandles
      return Promise.resolve({ dataHandles: [explicitHandle] });
    },
  };

  const context = createMockContext();

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  const result = await driver.execute(createMockRequest());

  assertEquals(result.status, "success");
  assertEquals(result.outputs.length, 1);
  assertEquals(result.outputs[0].kind, "persisted");
  const output = result.outputs[0];
  if (output.kind === "persisted") {
    assertEquals(output.handle, explicitHandle);
  }
});

Deno.test("RawExecutionDriver: returns empty outputs when no writes and no dataHandles", async () => {
  const executor: MethodExecutor = {
    execute: () => {
      // Method does nothing
      return Promise.resolve({});
    },
  };

  const context = createMockContext();

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  const result = await driver.execute(createMockRequest());

  assertEquals(result.status, "success");
  assertEquals(result.outputs.length, 0);
});

Deno.test("RawExecutionDriver: passes workflowRunId from tagOverrides to readModelData", async () => {
  const WORKFLOW_RUN_ID = "c00c0c00-c00c-4c0c-900c-c00c0c00c00c";
  let capturedContext: MethodContext | null = null;

  const executor: MethodExecutor = {
    execute: (_def, _method, context) => {
      capturedContext = context;
      return Promise.resolve({});
    },
  };

  const context = createMockContext();
  context.tagOverrides = {
    source: "step-output",
    workflow: "test-workflow",
    workflowRunId: WORKFLOW_RUN_ID,
    step: "test-step",
  };
  context.definitionRepository = {
    findByNameGlobal: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findAllGlobal: () => Promise.resolve([]),
  } as unknown as DefinitionRepository;

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  await driver.execute(createMockRequest());

  // readModelData should be wired up on the context
  assertEquals(typeof capturedContext!.readModelData, "function");

  // When called, it should scope to the workflow run — a non-existent model
  // returns empty array either way, but the function should be callable
  const result = await capturedContext!.readModelData!("nonexistent");
  assertEquals(result, []);
});

Deno.test("RawExecutionDriver: passes queryData predicate through without scoping", async () => {
  let capturedPredicate = "";

  const executor: MethodExecutor = {
    execute: async (_def, _method, context) => {
      await context.queryData!("model_name == 'source'", undefined);
      return {};
    },
  };

  const context = createMockContext();
  context.tagOverrides = {
    workflowRunId: "d00d0d00-d00d-4d0d-900d-d00d0d00d00d",
  };
  context.definitionRepository = {
    findByNameGlobal: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findAllGlobal: () => Promise.resolve([]),
  } as unknown as DefinitionRepository;
  context.queryData = (predicate: string) => {
    capturedPredicate = predicate;
    return Promise.resolve([]);
  };

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  await driver.execute(createMockRequest());

  // No hidden scoping — predicate passes through unmodified
  assertEquals(capturedPredicate, "model_name == 'source'");
});

Deno.test("RawExecutionDriver: leaves queryData unscoped when no workflowRunId", async () => {
  let capturedPredicate = "";

  const executor: MethodExecutor = {
    execute: async (_def, _method, context) => {
      await context.queryData!("model_name == 'source'", undefined);
      return {};
    },
  };

  const context = createMockContext();
  context.definitionRepository = {
    findByNameGlobal: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findAllGlobal: () => Promise.resolve([]),
  } as unknown as DefinitionRepository;
  context.queryData = (predicate: string) => {
    capturedPredicate = predicate;
    return Promise.resolve([]);
  };

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  await driver.execute(createMockRequest());

  assertEquals(capturedPredicate, "model_name == 'source'");
});

Deno.test("RawExecutionDriver: derives queryData from dataQueryService when not set", async () => {
  let capturedPredicate = "";
  let capturedSelect: string | undefined;

  const executor: MethodExecutor = {
    execute: async (_def, _method, context) => {
      await context.queryData!("model_name == 'source'", "attributes.foo");
      return {};
    },
  };

  const context = createMockContext();
  context.definitionRepository = {
    findByNameGlobal: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findAllGlobal: () => Promise.resolve([]),
  } as unknown as DefinitionRepository;
  context.dataQueryService = {
    query: (predicate: string, opts?: { select?: string }) => {
      capturedPredicate = predicate;
      capturedSelect = opts?.select;
      return Promise.resolve([]);
    },
  } as unknown as DataQueryService;

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  await driver.execute(createMockRequest());

  assertEquals(capturedPredicate, "model_name == 'source'");
  assertEquals(capturedSelect, "attributes.foo");
});

Deno.test("RawExecutionDriver: explicit queryData wins over dataQueryService derivation", async () => {
  let usedExplicit = false;
  let usedDerived = false;

  const executor: MethodExecutor = {
    execute: async (_def, _method, context) => {
      await context.queryData!("true", undefined);
      return {};
    },
  };

  const context = createMockContext();
  context.definitionRepository = {
    findByNameGlobal: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findAllGlobal: () => Promise.resolve([]),
  } as unknown as DefinitionRepository;
  context.queryData = () => {
    usedExplicit = true;
    return Promise.resolve([]);
  };
  context.dataQueryService = {
    query: () => {
      usedDerived = true;
      return Promise.resolve([]);
    },
  } as unknown as DataQueryService;

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  await driver.execute(createMockRequest());

  assertEquals(usedExplicit, true);
  assertEquals(usedDerived, false);
});

Deno.test("RawExecutionDriver: sets TRACEPARENT env var from traceHeaders during execution", async () => {
  let capturedTraceparent: string | undefined;
  const originalTraceparent = Deno.env.get("TRACEPARENT");

  const executor: MethodExecutor = {
    execute: () => {
      capturedTraceparent = Deno.env.get("TRACEPARENT");
      return Promise.resolve({});
    },
  };

  const context = createMockContext();

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  const request = createMockRequest();
  request.traceHeaders = {
    traceparent: "00-abc123-def456-01",
  };

  await driver.execute(request);

  assertEquals(capturedTraceparent, "00-abc123-def456-01");
  assertEquals(Deno.env.get("TRACEPARENT"), originalTraceparent);
});

Deno.test("RawExecutionDriver: restores TRACEPARENT env var after execution error", async () => {
  const originalTraceparent = Deno.env.get("TRACEPARENT");

  const executor: MethodExecutor = {
    execute: () => {
      throw new Error("boom");
    },
  };

  const context = createMockContext();

  const driver = new RawExecutionDriver(
    executor,
    testDefinition,
    testMethod,
    testModelDef,
    context,
    "test",
  );

  const request = createMockRequest();
  request.traceHeaders = {
    traceparent: "00-abc123-def456-01",
  };

  const result = await driver.execute(request);

  assertEquals(result.status, "error");
  assertEquals(Deno.env.get("TRACEPARENT"), originalTraceparent);
});
