import { assertEquals } from "@std/assert";
import { DataOutputValidationService } from "./data_output_validation_service.ts";
import {
  type DataHandle,
  type DataOutputSpecification,
  DataSpecType,
} from "./model.ts";
import type { DataId } from "../data/data_id.ts";

/**
 * Creates a test DataHandle with the given spec type and name.
 */
function createTestHandle(
  name: string,
  specTypeValue: string,
): DataHandle {
  return {
    name,
    specType: DataSpecType.create(specTypeValue),
    dataId: `mock-data-${name}` as DataId,
    version: 1,
    size: 0,
    tags: { type: "data" },
    metadata: {
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "data" },
      ownerDefinition: {
        definitionHash: "hash",
        ownerType: "model-method",
        ownerRef: "test",
      },
    },
  };
}

Deno.test("DataOutputValidationService - validate - accepts valid spec types", () => {
  const service = new DataOutputValidationService();

  const specs: Record<string, DataOutputSpecification> = {
    "message": {
      specType: DataSpecType.create("message"),
      description: "Test message",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
    "log": {
      specType: DataSpecType.create("log"),
      description: "Test log",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "log" },
    },
  };

  const dataHandles: DataHandle[] = [
    createTestHandle("foo-message", "message"),
    createTestHandle("bar-log", "log"),
  ];

  const result = service.validate(dataHandles, specs, "testMethod");

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("DataOutputValidationService - validate - passes for spec types not in specs (checked at writer creation)", () => {
  const service = new DataOutputValidationService();

  const specs: Record<string, DataOutputSpecification> = {
    "message": {
      specType: DataSpecType.create("message"),
      description: "Test message",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  };

  const dataHandles: DataHandle[] = [
    createTestHandle("foo-unknown", "unknown"),
  ];

  const result = service.validate(dataHandles, specs, "testMethod");

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("DataOutputValidationService - validate - detects duplicate instance names", () => {
  const service = new DataOutputValidationService();

  const specs: Record<string, DataOutputSpecification> = {
    "message": {
      specType: DataSpecType.create("message"),
      description: "Test message",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  };

  const dataHandles: DataHandle[] = [
    createTestHandle("duplicate", "message"),
    createTestHandle("duplicate", "message"),
  ];

  const result = service.validate(dataHandles, specs, "testMethod");

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0],
    "Duplicate data instance name 'duplicate' in method 'testMethod'",
  );
});
