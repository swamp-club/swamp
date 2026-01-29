import { assertEquals, assertThrows } from "@std/assert";
import { createModelResourceId, ModelResource } from "./model_resource.ts";

Deno.test("ModelResource.create generates UUID if not provided", () => {
  const resource = ModelResource.create({});
  assertEquals(typeof resource.id, "string");
  assertEquals(resource.id.length, 36);
});

Deno.test("ModelResource.create uses provided ID", () => {
  const id = "550e8400-e29b-41d4-a716-446655440001";
  const resource = ModelResource.create({ id });
  assertEquals(resource.id, id);
});

Deno.test("ModelResource.create sets default version to 1", () => {
  const resource = ModelResource.create({});
  assertEquals(resource.version, 1);
});

Deno.test("ModelResource.create uses provided version", () => {
  const resource = ModelResource.create({ version: 3 });
  assertEquals(resource.version, 3);
});

Deno.test("ModelResource.create sets createdAt to now if not provided", () => {
  const before = new Date();
  const resource = ModelResource.create({});
  const after = new Date();
  
  assertEquals(resource.createdAt >= before, true);
  assertEquals(resource.createdAt <= after, true);
});

Deno.test("ModelResource.create uses provided createdAt", () => {
  const createdAt = new Date("2023-01-01T00:00:00Z");
  const resource = ModelResource.create({ createdAt });
  assertEquals(resource.createdAt, createdAt);
});

Deno.test("ModelResource.create sets empty attributes by default", () => {
  const resource = ModelResource.create({});
  assertEquals(resource.attributes, {});
});

Deno.test("ModelResource.create uses provided attributes", () => {
  const attributes = { test: "value" };
  const resource = ModelResource.create({ attributes });
  assertEquals(resource.attributes, attributes);
});

Deno.test("ModelResource.create throws on invalid version", () => {
  assertThrows(
    () => ModelResource.create({ version: 0 }),
    Error,
    "Too small: expected number to be >0"
  );
});

Deno.test("ModelResource toData/fromData roundtrip", () => {
  const resource = ModelResource.create({});
  const data = resource.toData();
  const restored = ModelResource.fromData(data);
  
  assertEquals(restored.id, resource.id);
  assertEquals(restored.version, resource.version);
  assertEquals(restored.createdAt.getTime(), resource.createdAt.getTime());
  assertEquals(restored.attributes, resource.attributes);
});

Deno.test("ModelResource fromData with explicit data", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const createdAt = "2023-01-01T00:00:00.000Z";
  const attributes = { key: "value" };
  
  const data = {
    id,
    version: 2,
    createdAt,
    attributes,
  };
  
  const resource = ModelResource.fromData(data);
  assertEquals(resource.id, id);
  assertEquals(resource.version, 2);
  assertEquals(resource.createdAt, new Date(createdAt));
  assertEquals(resource.attributes, attributes);
});

Deno.test("ModelResource setAttribute", () => {
  const resource = ModelResource.create({});
  resource.setAttribute("test", "value");
  assertEquals(resource.attributes.test, "value");
});