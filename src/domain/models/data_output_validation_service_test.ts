import { assertEquals } from "@std/assert";
import { DataOutputValidationService } from "./data_output_validation_service.ts";
import {
  type DataOutput,
  type DataOutputSpecification,
  DataSpecType,
} from "./model.ts";
import type { DataOutputOverride } from "./data_output_override.ts";

Deno.test("DataOutputValidationService - validate - accepts valid spec types", () => {
  const service = new DataOutputValidationService();

  const specs: Record<string, DataOutputSpecification> = {
    "message": {
      specType: DataSpecType.create("message"),
      description: "Test message",
    },
    "log": {
      specType: DataSpecType.create("log"),
      description: "Test log",
    },
  };

  const dataOutputs: DataOutput[] = [
    {
      name: "foo-message",
      specType: DataSpecType.create("message"),
      content: new Uint8Array(),
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
    },
    {
      name: "bar-log",
      specType: DataSpecType.create("log"),
      content: new Uint8Array(),
      metadata: {
        contentType: "text/plain",
        lifetime: "ephemeral",
        garbageCollection: 5,
        streaming: false,
        tags: { type: "log" },
        ownerDefinition: {
          definitionHash: "hash",
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    },
  ];

  const result = service.validate(dataOutputs, specs, "testMethod");

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("DataOutputValidationService - validate - detects undeclared spec type", () => {
  const service = new DataOutputValidationService();

  const specs: Record<string, DataOutputSpecification> = {
    "message": {
      specType: DataSpecType.create("message"),
      description: "Test message",
    },
  };

  const dataOutputs: DataOutput[] = [
    {
      name: "foo-unknown",
      specType: DataSpecType.create("unknown"),
      content: new Uint8Array(),
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
    },
  ];

  const result = service.validate(dataOutputs, specs, "testMethod");

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0],
    "Data output 'foo-unknown' references undeclared spec type 'unknown' in method 'testMethod'. Declared spec types: message",
  );
});

Deno.test("DataOutputValidationService - validate - detects duplicate instance names", () => {
  const service = new DataOutputValidationService();

  const specs: Record<string, DataOutputSpecification> = {
    "message": {
      specType: DataSpecType.create("message"),
      description: "Test message",
    },
  };

  const dataOutputs: DataOutput[] = [
    {
      name: "duplicate",
      specType: DataSpecType.create("message"),
      content: new Uint8Array(),
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
    },
    {
      name: "duplicate",
      specType: DataSpecType.create("message"),
      content: new Uint8Array(),
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
    },
  ];

  const result = service.validate(dataOutputs, specs, "testMethod");

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0],
    "Duplicate data instance name 'duplicate' in method 'testMethod'",
  );
});

Deno.test("DataOutputValidationService - applyDefaultsAndOverrides - applies spec defaults", () => {
  const service = new DataOutputValidationService();

  const spec: DataOutputSpecification = {
    specType: DataSpecType.create("message"),
    contentType: "text/plain",
    lifetime: "ephemeral",
    garbageCollection: 5,
    streaming: true,
    tags: { specTag: "specValue" },
  };

  const dataOutput: DataOutput = {
    name: "test-message",
    specType: DataSpecType.create("message"),
    content: new Uint8Array(),
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

  const result = service.applyDefaultsAndOverrides(dataOutput, spec);

  // Existing values should be preserved
  assertEquals(result.metadata.contentType, "application/json");
  assertEquals(result.metadata.lifetime, "infinite");
  assertEquals(result.metadata.garbageCollection, 10);
  assertEquals(result.metadata.streaming, false);

  // Tags should be merged (spec tags + metadata tags)
  assertEquals(result.metadata.tags, {
    specTag: "specValue",
    type: "data",
  });
});

Deno.test("DataOutputValidationService - applyDefaultsAndOverrides - fills missing values from spec", () => {
  const service = new DataOutputValidationService();

  const spec: DataOutputSpecification = {
    specType: DataSpecType.create("message"),
    contentType: "text/plain",
    lifetime: "ephemeral",
    garbageCollection: 5,
    streaming: true,
    tags: { specTag: "specValue" },
  };

  const dataOutput: DataOutput = {
    name: "test-message",
    specType: DataSpecType.create("message"),
    content: new Uint8Array(),
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

  // Remove some metadata to test defaults
  delete (dataOutput.metadata as { contentType?: string }).contentType;
  delete (dataOutput.metadata as { lifetime?: string }).lifetime;

  const result = service.applyDefaultsAndOverrides(dataOutput, spec);

  // Should use spec defaults
  assertEquals(result.metadata.contentType, "text/plain");
  assertEquals(result.metadata.lifetime, "ephemeral");
});

Deno.test("DataOutputValidationService - applyDefaultsAndOverrides - applies overrides", () => {
  const service = new DataOutputValidationService();

  const spec: DataOutputSpecification = {
    specType: DataSpecType.create("message"),
    contentType: "text/plain",
    lifetime: "ephemeral",
    garbageCollection: 5,
    tags: { specTag: "specValue" },
  };

  const dataOutput: DataOutput = {
    name: "test-message",
    specType: DataSpecType.create("message"),
    content: new Uint8Array(),
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

  const overrides: DataOutputOverride[] = [
    {
      specType: DataSpecType.create("message"),
      lifetime: "7d",
      garbageCollection: 20,
      tags: { overrideTag: "overrideValue" },
    },
  ];

  const result = service.applyDefaultsAndOverrides(dataOutput, spec, overrides);

  // Overrides should take precedence
  assertEquals(result.metadata.lifetime, "7d");
  assertEquals(result.metadata.garbageCollection, 20);

  // Tags should be merged (spec + metadata + override)
  assertEquals(result.metadata.tags, {
    specTag: "specValue",
    type: "data",
    overrideTag: "overrideValue",
  });
});

Deno.test("DataOutputValidationService - applyDefaultsAndOverrides - uses hardcoded defaults when spec has no defaults", () => {
  const service = new DataOutputValidationService();

  const spec: DataOutputSpecification = {
    specType: DataSpecType.create("message"),
    // No defaults provided
  };

  const dataOutput: DataOutput = {
    name: "test-message",
    specType: DataSpecType.create("message"),
    content: new Uint8Array(),
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

  // Remove metadata to test hardcoded defaults
  delete (dataOutput.metadata as { contentType?: string }).contentType;
  delete (dataOutput.metadata as { lifetime?: string }).lifetime;
  delete (dataOutput.metadata as { garbageCollection?: number })
    .garbageCollection;
  delete (dataOutput.metadata as { streaming?: boolean }).streaming;

  const result = service.applyDefaultsAndOverrides(dataOutput, spec);

  // Should use hardcoded defaults
  assertEquals(result.metadata.contentType, "application/json");
  assertEquals(result.metadata.lifetime, "infinite");
  assertEquals(result.metadata.garbageCollection, 10);
  assertEquals(result.metadata.streaming, false);
});
