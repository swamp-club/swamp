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
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { type DataId, generateDataId } from "../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

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
