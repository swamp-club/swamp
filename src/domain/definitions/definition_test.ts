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

Deno.test("Definition.create sets empty globalArguments by default", () => {
  const definition = Definition.create({ name: "test-definition" });
  assertEquals(definition.globalArguments, {});
});

Deno.test("Definition.create uses provided globalArguments", () => {
  const globalArguments = { message: "hello", count: 42 };
  const definition = Definition.create({
    name: "test-definition",
    globalArguments,
  });
  assertEquals(definition.globalArguments, globalArguments);
});

Deno.test("Definition.create supports globalArguments with CEL expressions", () => {
  const globalArguments = {
    message: "${{ model.other.input.attributes.greeting }}",
    computed: "${{ inputs.value * 2 }}",
  };
  const definition = Definition.create({
    name: "test-definition",
    globalArguments,
  });
  assertEquals(definition.globalArguments, globalArguments);
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

Deno.test("Definition.setGlobalArgument adds/updates globalArguments", () => {
  const definition = Definition.create({ name: "test-definition" });
  definition.setGlobalArgument("message", "hello");
  assertEquals(definition.globalArguments.message, "hello");
});

Deno.test("Definition.removeGlobalArgument removes globalArguments", () => {
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });
  assertEquals(definition.globalArguments.message, "hello");

  definition.removeGlobalArgument("message");
  assertEquals(definition.globalArguments.message, undefined);
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
    globalArguments: { message: "hello" },
    inputs: {
      type: "object" as const,
      properties: { name: { type: "string" as const } },
    },
  });

  const data = definition.toData();
  assertEquals(data, {
    type: undefined,
    typeVersion: undefined,
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-definition",
    version: 2,
    tags: { env: "prod" },
    globalArguments: { message: "hello" },
    methods: {},
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
    globalArguments: { message: "hello" },
    methods: {},
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
  assertEquals(definition.globalArguments, data.globalArguments);
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

Deno.test("Definition.globalArguments returns a copy, not the original", () => {
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { a: 1 },
  });
  const attrs = definition.globalArguments;
  attrs.b = 2;
  assertEquals(definition.globalArguments.b, undefined);
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

Deno.test("Definition.globalArguments handles deep nesting", () => {
  const globalArguments = {
    nested: {
      deep: {
        value: "${{ model.foo.input.attributes.bar }}",
        list: [1, 2, "${{ inputs.count }}"],
      },
    },
  };
  const definition = Definition.create({
    name: "test-definition",
    globalArguments,
  });

  // Modifying the returned globalArguments shouldn't affect the original
  const attrs = definition.globalArguments;
  (attrs.nested as Record<string, unknown>).deep = "modified";
  assertEquals(
    (definition.globalArguments.nested as Record<string, unknown>).deep,
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
    globalArguments: { message: "hello" },
  });

  const definition2 = Definition.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-definition",
    version: 1,
    globalArguments: { message: "hello" },
  });

  const hash1 = await definition1.computeHash();
  const hash2 = await definition2.computeHash();

  assertEquals(hash1, hash2);
  assertEquals(hash1.length, 64); // SHA-256 hex string length
});

Deno.test("Definition.computeHash returns different hash for different content", async () => {
  const definition1 = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const definition2 = Definition.create({
    name: "test-definition",
    globalArguments: { message: "world" },
  });

  const hash1 = await definition1.computeHash();
  const hash2 = await definition2.computeHash();

  // Different content should produce different hashes
  // Note: IDs will be different, so hashes will definitely differ
  assertEquals(hash1 !== hash2, true);
});

Deno.test("Definition.create with type and typeVersion", () => {
  const definition = Definition.create({
    name: "test-definition",
    type: "swamp/echo",
    typeVersion: "2026.02.09.1",
  });
  assertEquals(definition.type, "swamp/echo");
  assertEquals(definition.typeVersion, "2026.02.09.1");
});

Deno.test("Definition.create without type and typeVersion defaults to undefined", () => {
  const definition = Definition.create({ name: "test-definition" });
  assertEquals(definition.type, undefined);
  assertEquals(definition.typeVersion, undefined);
});

Deno.test("Definition.toData includes type and typeVersion", () => {
  const definition = Definition.create({
    name: "test-definition",
    type: "swamp/echo",
    typeVersion: "2026.02.09.2",
  });
  const data = definition.toData();
  assertEquals(data.type, "swamp/echo");
  assertEquals(data.typeVersion, "2026.02.09.2");
});

Deno.test("Definition.fromData round-trips type and typeVersion", () => {
  const definition = Definition.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-definition",
    type: "aws/ec2/vpc",
    typeVersion: "2026.02.09.3",
  });
  const data = definition.toData();
  const restored = Definition.fromData(data);
  assertEquals(restored.type, "aws/ec2/vpc");
  assertEquals(restored.typeVersion, "2026.02.09.3");
  assertEquals(restored.id, definition.id);
  assertEquals(restored.name, definition.name);
});

Deno.test("Definition.computeHash is stable regardless of type/typeVersion", async () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const defWithout = Definition.create({
    id,
    name: "test-definition",
    version: 1,
    globalArguments: { message: "hello" },
  });

  const defWith = Definition.create({
    id,
    name: "test-definition",
    version: 1,
    globalArguments: { message: "hello" },
    type: "swamp/echo",
    typeVersion: "2026.02.09.1",
  });

  const hash1 = await defWithout.computeHash();
  const hash2 = await defWith.computeHash();

  assertEquals(hash1, hash2);
});

// --- withUpgradedGlobalArguments tests ---

Deno.test("Definition.withUpgradedGlobalArguments preserves id, name, tags", () => {
  const original = Definition.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "my-definition",
    type: "swamp/echo",
    typeVersion: "2025.01.15.1",
    tags: { env: "prod" },
    globalArguments: { message: "hello" },
  });

  const upgraded = Definition.withUpgradedGlobalArguments(
    original,
    { content: "hello", priority: "medium" },
    "2026.02.09.1",
  );

  assertEquals(upgraded.id, "550e8400-e29b-41d4-a716-446655440000");
  assertEquals(upgraded.name, "my-definition");
  assertEquals(upgraded.type, "swamp/echo");
  assertEquals(upgraded.tags, { env: "prod" });
  assertEquals(upgraded.version, 1);
});

Deno.test("Definition.withUpgradedGlobalArguments updates globalArguments and typeVersion", () => {
  const original = Definition.create({
    name: "test-def",
    type: "swamp/echo",
    typeVersion: "2025.01.15.1",
    globalArguments: { message: "old" },
  });

  const upgraded = Definition.withUpgradedGlobalArguments(
    original,
    { content: "new", priority: "high" },
    "2026.02.09.1",
  );

  assertEquals(upgraded.globalArguments, { content: "new", priority: "high" });
  assertEquals(upgraded.typeVersion, "2026.02.09.1");
  // Original should be unchanged
  assertEquals(original.globalArguments, { message: "old" });
  assertEquals(original.typeVersion, "2025.01.15.1");
});

Deno.test("Legacy numeric typeVersion coerced to undefined", () => {
  const definition = Definition.fromData({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "legacy-def",
    version: 1,
    type: "swamp/echo",
    typeVersion: 1 as unknown as string,
    tags: {},
    globalArguments: { message: "hello" },
    methods: {},
    inputs: undefined,
  });

  assertEquals(definition.typeVersion, undefined);
});
