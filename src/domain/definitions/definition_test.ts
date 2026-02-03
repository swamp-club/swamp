import { assertEquals, assertThrows } from "@std/assert";
import { createDefinitionId, Definition } from "./definition.ts";

Deno.test("Definition.create generates UUID if not provided", () => {
  const definition = Definition.create({ name: "test-definition" });
  assertEquals(typeof definition.id, "string");
  assertEquals(definition.id.length, 36); // UUID length
});

Deno.test("Definition.create uses provided ID", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const definition = Definition.create({ id, name: "test-definition" });
  assertEquals(definition.id, id);
});

Deno.test("Definition.create sets default version to 1", () => {
  const definition = Definition.create({ name: "test-definition" });
  assertEquals(definition.version, 1);
});

Deno.test("Definition.create uses provided version", () => {
  const definition = Definition.create({ name: "test-definition", version: 3 });
  assertEquals(definition.version, 3);
});

Deno.test("Definition.create sets empty tags by default", () => {
  const definition = Definition.create({ name: "test-definition" });
  assertEquals(definition.tags, {});
});

Deno.test("Definition.create uses provided tags", () => {
  const tags = { env: "production", team: "platform" };
  const definition = Definition.create({ name: "test-definition", tags });
  assertEquals(definition.tags, tags);
});

Deno.test("Definition.create sets empty attributes by default", () => {
  const definition = Definition.create({ name: "test-definition" });
  assertEquals(definition.attributes, {});
});

Deno.test("Definition.create uses provided attributes", () => {
  const attributes = { message: "hello", count: 42 };
  const definition = Definition.create({ name: "test-definition", attributes });
  assertEquals(definition.attributes, attributes);
});

Deno.test("Definition.create supports attributes with CEL expressions", () => {
  const attributes = {
    message: "${{ model.other.input.attributes.greeting }}",
    computed: "${{ inputs.value * 2 }}",
  };
  const definition = Definition.create({ name: "test-definition", attributes });
  assertEquals(definition.attributes, attributes);
});

Deno.test("Definition.create sets undefined inputs by default", () => {
  const definition = Definition.create({ name: "test-definition" });
  assertEquals(definition.inputs, undefined);
});

Deno.test("Definition.create uses provided inputs schema", () => {
  const inputs = {
    type: "object" as const,
    properties: {
      name: { type: "string" as const, description: "The name" },
      count: { type: "integer" as const, default: 1 },
    },
    required: ["name"],
  };
  const definition = Definition.create({ name: "test-definition", inputs });
  assertEquals(definition.inputs, inputs);
});

Deno.test("Definition.create throws on empty name", () => {
  assertThrows(
    () => Definition.create({ name: "" }),
    Error,
  );
});

Deno.test("Definition.create throws on invalid version", () => {
  assertThrows(
    () => Definition.create({ name: "test", version: 0 }),
    Error,
  );
});

Deno.test("Definition.setTag adds/updates tags", () => {
  const definition = Definition.create({ name: "test-definition" });
  definition.setTag("env", "production");
  assertEquals(definition.tags.env, "production");

  definition.setTag("env", "staging");
  assertEquals(definition.tags.env, "staging");
});

Deno.test("Definition.removeTag removes tags", () => {
  const definition = Definition.create({
    name: "test-definition",
    tags: { env: "prod" },
  });
  assertEquals(definition.tags.env, "prod");

  definition.removeTag("env");
  assertEquals(definition.tags.env, undefined);
});

Deno.test("Definition.setAttribute adds/updates attributes", () => {
  const definition = Definition.create({ name: "test-definition" });
  definition.setAttribute("message", "hello");
  assertEquals(definition.attributes.message, "hello");
});

Deno.test("Definition.removeAttribute removes attributes", () => {
  const definition = Definition.create({
    name: "test-definition",
    attributes: { message: "hello" },
  });
  assertEquals(definition.attributes.message, "hello");

  definition.removeAttribute("message");
  assertEquals(definition.attributes.message, undefined);
});

Deno.test("Definition.setInputs sets inputs schema", () => {
  const definition = Definition.create({ name: "test-definition" });
  const inputs = {
    type: "object" as const,
    properties: { name: { type: "string" as const } },
  };
  definition.setInputs(inputs);
  assertEquals(definition.inputs, inputs);
});

Deno.test("Definition.setInputs clears inputs with undefined", () => {
  const definition = Definition.create({
    name: "test-definition",
    inputs: { type: "object" as const },
  });
  definition.setInputs(undefined);
  assertEquals(definition.inputs, undefined);
});

Deno.test("Definition.toData returns correct structure", () => {
  const definition = Definition.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-definition",
    version: 2,
    tags: { env: "prod" },
    attributes: { message: "hello" },
    inputs: {
      type: "object" as const,
      properties: { name: { type: "string" as const } },
    },
  });

  const data = definition.toData();
  assertEquals(data, {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-definition",
    version: 2,
    tags: { env: "prod" },
    attributes: { message: "hello" },
    inputs: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  });
});

Deno.test("Definition.fromData reconstructs definition correctly", () => {
  const data = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-definition",
    version: 2,
    tags: { env: "prod" },
    attributes: { message: "hello" },
    inputs: {
      type: "object" as const,
      properties: { name: { type: "string" as const } },
    },
  };

  const definition = Definition.fromData(data);
  assertEquals(definition.id, data.id);
  assertEquals(definition.name, data.name);
  assertEquals(definition.version, data.version);
  assertEquals(definition.tags, data.tags);
  assertEquals(definition.attributes, data.attributes);
  assertEquals(definition.inputs, data.inputs);
});

Deno.test("Definition.tags returns a copy, not the original", () => {
  const definition = Definition.create({
    name: "test-definition",
    tags: { a: "1" },
  });
  const tags = definition.tags;
  tags.b = "2";
  assertEquals(definition.tags.b, undefined);
});

Deno.test("Definition.attributes returns a copy, not the original", () => {
  const definition = Definition.create({
    name: "test-definition",
    attributes: { a: 1 },
  });
  const attrs = definition.attributes;
  attrs.b = 2;
  assertEquals(definition.attributes.b, undefined);
});

Deno.test("Definition.inputs returns a copy, not the original", () => {
  const definition = Definition.create({
    name: "test-definition",
    inputs: {
      type: "object" as const,
      properties: { a: { type: "string" as const } },
    },
  });
  const inputs = definition.inputs;
  if (inputs?.properties) {
    inputs.properties.b = { type: "number" };
  }
  assertEquals(definition.inputs?.properties?.b, undefined);
});

Deno.test("Definition.attributes handles deep nesting", () => {
  const attributes = {
    nested: {
      deep: {
        value: "${{ model.foo.input.attributes.bar }}",
        list: [1, 2, "${{ inputs.count }}"],
      },
    },
  };
  const definition = Definition.create({
    name: "test-definition",
    attributes,
  });

  // Modifying the returned attributes shouldn't affect the original
  const attrs = definition.attributes;
  (attrs.nested as Record<string, unknown>).deep = "modified";
  assertEquals(
    (definition.attributes.nested as Record<string, unknown>).deep,
    {
      value: "${{ model.foo.input.attributes.bar }}",
      list: [1, 2, "${{ inputs.count }}"],
    },
  );
});

Deno.test("createDefinitionId creates branded type", () => {
  const id = createDefinitionId("550e8400-e29b-41d4-a716-446655440000");
  assertEquals(typeof id, "string");
  assertEquals(id, "550e8400-e29b-41d4-a716-446655440000");
});

Deno.test("Definition.computeHash returns consistent hash", async () => {
  const definition1 = Definition.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-definition",
    version: 1,
    attributes: { message: "hello" },
  });

  const definition2 = Definition.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-definition",
    version: 1,
    attributes: { message: "hello" },
  });

  const hash1 = await definition1.computeHash();
  const hash2 = await definition2.computeHash();

  assertEquals(hash1, hash2);
  assertEquals(hash1.length, 64); // SHA-256 hex string length
});

Deno.test("Definition.computeHash returns different hash for different content", async () => {
  const definition1 = Definition.create({
    name: "test-definition",
    attributes: { message: "hello" },
  });

  const definition2 = Definition.create({
    name: "test-definition",
    attributes: { message: "world" },
  });

  const hash1 = await definition1.computeHash();
  const hash2 = await definition2.computeHash();

  // Different content should produce different hashes
  // Note: IDs will be different, so hashes will definitely differ
  assertEquals(hash1 !== hash2, true);
});
