import { assertEquals } from "@std/assert";
import { DataOutputValidationService } from "./data_output_validation_service.ts";
import type { DataHandle } from "./model.ts";
import type { DataId } from "../data/data_id.ts";

/**
 * Creates a test DataHandle with the given spec name and kind.
 */
function createTestHandle(
  name: string,
  specName: string,
  kind: "resource" | "file" = "resource",
): DataHandle {
  return {
    name,
    specName,
    kind,
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

Deno.test("DataOutputValidationService - validate - accepts valid handles", () => {
  const service = new DataOutputValidationService();

  const dataHandles: DataHandle[] = [
    createTestHandle("foo-message", "message", "resource"),
    createTestHandle("bar-log", "log", "file"),
  ];

  const result = service.validate(dataHandles);

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("DataOutputValidationService - validate - passes for handles with any spec name", () => {
  const service = new DataOutputValidationService();

  const dataHandles: DataHandle[] = [
    createTestHandle("foo-unknown", "unknown", "resource"),
  ];

  const result = service.validate(dataHandles);

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("DataOutputValidationService - validate - detects duplicate instance names", () => {
  const service = new DataOutputValidationService();

  const dataHandles: DataHandle[] = [
    createTestHandle("duplicate", "message", "resource"),
    createTestHandle("duplicate", "message", "resource"),
  ];

  const result = service.validate(dataHandles);

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0],
    "Duplicate data instance name 'duplicate'",
  );
});
