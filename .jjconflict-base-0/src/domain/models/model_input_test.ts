import { assertEquals, assertThrows } from "@std/assert";
import { createModelInputId, ModelInput } from "./model_input.ts";

Deno.test("ModelInput.create generates UUID if not provided", () => {
  const input = ModelInput.create({ name: "test-input" });
  assertEquals(typeof input.id, "string");
  assertEquals(input.id.length, 36); // UUID length
});

Deno.test("ModelInput.create uses provided ID", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const input = ModelInput.create({ id, name: "test-input" });
  assertEquals(input.id, id);
});

Deno.test("ModelInput.create sets default version to 1", () => {
  const input = ModelInput.create({ name: "test-input" });
  assertEquals(input.version, 1);
});

Deno.test("ModelInput.create uses provided version", () => {
  const input = ModelInput.create({ name: "test-input", version: 3 });
  assertEquals(input.version, 3);
});

Deno.test("ModelInput.create sets empty tags by default", () => {
  const input = ModelInput.create({ name: "test-input" });
  assertEquals(input.tags, {});
});

Deno.test("ModelInput.create uses provided tags", () => {
  const tags = { env: "production", team: "platform" };
  const input = ModelInput.create({ name: "test-input", tags });
  assertEquals(input.tags, tags);
});

Deno.test("ModelInput.create sets empty attributes by default", () => {
  const input = ModelInput.create({ name: "test-input" });
  assertEquals(input.attributes, {});
});

Deno.test("ModelInput.create uses provided attributes", () => {
  const attributes = { message: "hello", count: 42 };
  const input = ModelInput.create({ name: "test-input", attributes });
  assertEquals(input.attributes, attributes);
});

Deno.test("ModelInput.create throws on empty name", () => {
  assertThrows(
    () => ModelInput.create({ name: "" }),
    Error,
  );
});

Deno.test("ModelInput.create throws on invalid version", () => {
  assertThrows(
    () => ModelInput.create({ name: "test", version: 0 }),
    Error,
  );
});

Deno.test("ModelInput.setResourceId updates resourceId", () => {
  const input = ModelInput.create({ name: "test-input" });
  assertEquals(input.resourceId, undefined);

  const resourceId = "550e8400-e29b-41d4-a716-446655440001";
  input.setResourceId(resourceId);
  assertEquals(input.resourceId, resourceId);
});

Deno.test("ModelInput.setTag adds/updates tags", () => {
  const input = ModelInput.create({ name: "test-input" });
  input.setTag("env", "production");
  assertEquals(input.tags.env, "production");

  input.setTag("env", "staging");
  assertEquals(input.tags.env, "staging");
});

Deno.test("ModelInput.removeTag removes tags", () => {
  const input = ModelInput.create({
    name: "test-input",
    tags: { env: "prod" },
  });
  assertEquals(input.tags.env, "prod");

  input.removeTag("env");
  assertEquals(input.tags.env, undefined);
});

Deno.test("ModelInput.setAttribute adds/updates attributes", () => {
  const input = ModelInput.create({ name: "test-input" });
  input.setAttribute("message", "hello");
  assertEquals(input.attributes.message, "hello");
});

Deno.test("ModelInput.toData returns correct structure", () => {
  const input = ModelInput.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-input",
    version: 2,
    tags: { env: "prod" },
    attributes: { message: "hello" },
  });
  input.setResourceId("550e8400-e29b-41d4-a716-446655440001");

  const data = input.toData();
  assertEquals(data, {
    id: "550e8400-e29b-41d4-a716-446655440000",
    resourceId: "550e8400-e29b-41d4-a716-446655440001",
    name: "test-input",
    version: 2,
    tags: { env: "prod" },
    attributes: { message: "hello" },
  });
});

Deno.test("ModelInput.fromData reconstructs input correctly", () => {
  const data = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    resourceId: "550e8400-e29b-41d4-a716-446655440001",
    name: "test-input",
    version: 2,
    tags: { env: "prod" },
    attributes: { message: "hello" },
  };

  const input = ModelInput.fromData(data);
  assertEquals(input.id, data.id);
  assertEquals(input.resourceId, data.resourceId);
  assertEquals(input.name, data.name);
  assertEquals(input.version, data.version);
  assertEquals(input.tags, data.tags);
  assertEquals(input.attributes, data.attributes);
});

Deno.test("ModelInput.tags returns a copy, not the original", () => {
  const input = ModelInput.create({ name: "test-input", tags: { a: "1" } });
  const tags = input.tags;
  tags.b = "2";
  assertEquals(input.tags.b, undefined);
});

Deno.test("ModelInput.attributes returns a copy, not the original", () => {
  const input = ModelInput.create({ name: "test-input", attributes: { a: 1 } });
  const attrs = input.attributes;
  attrs.b = 2;
  assertEquals(input.attributes.b, undefined);
});

Deno.test("createModelInputId creates branded type", () => {
  const id = createModelInputId("550e8400-e29b-41d4-a716-446655440000");
  assertEquals(typeof id, "string");
  assertEquals(id, "550e8400-e29b-41d4-a716-446655440000");
});
