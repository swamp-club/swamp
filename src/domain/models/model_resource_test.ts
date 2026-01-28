import { assertEquals, assertThrows } from "@std/assert";
import { createModelResourceId, ModelResource } from "./model_resource.ts";

const TEST_INPUT_ID = "550e8400-e29b-41d4-a716-446655440000";

Deno.test("ModelResource.create generates UUID if not provided", () => {
  const resource = ModelResource.create({ inputId: TEST_INPUT_ID });
  assertEquals(typeof resource.id, "string");
  assertEquals(resource.id.length, 36);
});

Deno.test("ModelResource.create uses provided ID", () => {
  const id = "550e8400-e29b-41d4-a716-446655440001";
  const resource = ModelResource.create({ id, inputId: TEST_INPUT_ID });
  assertEquals(resource.id, id);
});

Deno.test("ModelResource.create sets inputId", () => {
  const resource = ModelResource.create({ inputId: TEST_INPUT_ID });
  assertEquals(resource.inputId, TEST_INPUT_ID);
});

Deno.test("ModelResource.create sets default version to 1", () => {
  const resource = ModelResource.create({ inputId: TEST_INPUT_ID });
  assertEquals(resource.version, 1);
});

Deno.test("ModelResource.create uses provided version", () => {
  const resource = ModelResource.create({ inputId: TEST_INPUT_ID, version: 3 });
  assertEquals(resource.version, 3);
});

Deno.test("ModelResource.create sets createdAt to now if not provided", () => {
  const before = new Date();
  const resource = ModelResource.create({ inputId: TEST_INPUT_ID });
  const after = new Date();

  assertEquals(resource.createdAt >= before, true);
  assertEquals(resource.createdAt <= after, true);
});

Deno.test("ModelResource.create uses provided createdAt", () => {
  const createdAt = new Date("2024-01-15T10:30:00Z");
  const resource = ModelResource.create({ inputId: TEST_INPUT_ID, createdAt });
  assertEquals(resource.createdAt.toISOString(), createdAt.toISOString());
});

Deno.test("ModelResource.create sets empty attributes by default", () => {
  const resource = ModelResource.create({ inputId: TEST_INPUT_ID });
  assertEquals(resource.attributes, {});
});

Deno.test("ModelResource.create uses provided attributes", () => {
  const attributes = { message: "hello", timestamp: "2024-01-15" };
  const resource = ModelResource.create({ inputId: TEST_INPUT_ID, attributes });
  assertEquals(resource.attributes, attributes);
});

Deno.test("ModelResource.create throws on invalid inputId", () => {
  assertThrows(
    () => ModelResource.create({ inputId: "not-a-uuid" }),
    Error,
  );
});

Deno.test("ModelResource.create throws on invalid version", () => {
  assertThrows(
    () => ModelResource.create({ inputId: TEST_INPUT_ID, version: 0 }),
    Error,
  );
});

Deno.test("ModelResource.setAttribute adds/updates attributes", () => {
  const resource = ModelResource.create({ inputId: TEST_INPUT_ID });
  resource.setAttribute("message", "hello");
  assertEquals(resource.attributes.message, "hello");

  resource.setAttribute("message", "world");
  assertEquals(resource.attributes.message, "world");
});

Deno.test("ModelResource.toData returns correct structure", () => {
  const createdAt = new Date("2024-01-15T10:30:00.000Z");
  const resource = ModelResource.create({
    id: "550e8400-e29b-41d4-a716-446655440001",
    inputId: TEST_INPUT_ID,
    version: 2,
    createdAt,
    attributes: { message: "hello" },
  });

  const data = resource.toData();
  assertEquals(data, {
    id: "550e8400-e29b-41d4-a716-446655440001",
    inputId: TEST_INPUT_ID,
    version: 2,
    createdAt: "2024-01-15T10:30:00.000Z",
    attributes: { message: "hello" },
  });
});

Deno.test("ModelResource.fromData reconstructs resource correctly", () => {
  const data = {
    id: "550e8400-e29b-41d4-a716-446655440001",
    inputId: TEST_INPUT_ID,
    version: 2,
    createdAt: "2024-01-15T10:30:00.000Z",
    attributes: { message: "hello" },
  };

  const resource = ModelResource.fromData(data);
  assertEquals(resource.id, data.id);
  assertEquals(resource.inputId, data.inputId);
  assertEquals(resource.version, data.version);
  assertEquals(resource.createdAt.toISOString(), data.createdAt);
  assertEquals(resource.attributes, data.attributes);
});

Deno.test("ModelResource.attributes returns a copy, not the original", () => {
  const resource = ModelResource.create({
    inputId: TEST_INPUT_ID,
    attributes: { a: 1 },
  });
  const attrs = resource.attributes;
  attrs.b = 2;
  assertEquals(resource.attributes.b, undefined);
});

Deno.test("createModelResourceId creates branded type", () => {
  const id = createModelResourceId("550e8400-e29b-41d4-a716-446655440001");
  assertEquals(typeof id, "string");
  assertEquals(id, "550e8400-e29b-41d4-a716-446655440001");
});
