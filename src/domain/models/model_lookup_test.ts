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
import {
  findDefinitionByIdOrName,
  isPartialId,
  isUuid,
  matchByPartialId,
} from "./model_lookup.ts";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "./model_type.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
// Import models barrel to register all model types (needed for findDefinitionByIdOrName tests)
import "./models.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lookup-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("isUuid returns true for valid UUID v4", () => {
  assertEquals(isUuid("550e8400-e29b-41d4-a716-446655440000"), true);
  assertEquals(isUuid("6ba7b810-9dad-41d4-80b4-00c04fd430c8"), true);
  assertEquals(isUuid("f47ac10b-58cc-4372-a567-0e02b2c3d479"), true);
});

Deno.test("isUuid is case insensitive", () => {
  assertEquals(isUuid("550E8400-E29B-41D4-A716-446655440000"), true);
  assertEquals(isUuid("550e8400-E29B-41d4-a716-446655440000"), true);
});

Deno.test("isUuid returns false for invalid UUIDs", () => {
  // Not a UUID at all
  assertEquals(isUuid("hello"), false);
  assertEquals(isUuid("my-model-name"), false);

  // Wrong length
  assertEquals(isUuid("550e8400-e29b-41d4-a716-44665544000"), false);
  assertEquals(isUuid("550e8400-e29b-41d4-a716-4466554400000"), false);

  // Wrong format (missing dashes)
  assertEquals(isUuid("550e8400e29b41d4a716446655440000"), false);

  // Not a v4 UUID (version digit is not 4)
  assertEquals(isUuid("550e8400-e29b-11d4-a716-446655440000"), false);
  assertEquals(isUuid("550e8400-e29b-51d4-a716-446655440000"), false);

  // Invalid variant (4th group must start with 8, 9, a, or b)
  assertEquals(isUuid("550e8400-e29b-41d4-0716-446655440000"), false);
  assertEquals(isUuid("550e8400-e29b-41d4-c716-446655440000"), false);
});

Deno.test("isUuid returns false for empty string", () => {
  assertEquals(isUuid(""), false);
});

// isPartialId tests

Deno.test("isPartialId returns true for valid partial IDs (3+ hex chars)", () => {
  assertEquals(isPartialId("abc"), true);
  assertEquals(isPartialId("5ec"), true);
  assertEquals(isPartialId("5ece291"), true);
  assertEquals(isPartialId("5ece291a-46c0"), true);
});

Deno.test("isPartialId returns true for full UUIDs", () => {
  assertEquals(isPartialId("550e8400-e29b-41d4-a716-446655440000"), true);
});

Deno.test("isPartialId returns false for too short strings", () => {
  assertEquals(isPartialId("ab"), false);
  assertEquals(isPartialId("5"), false);
  assertEquals(isPartialId(""), false);
});

Deno.test("isPartialId returns false for non-hex characters", () => {
  assertEquals(isPartialId("xyz"), false);
  assertEquals(isPartialId("model-name"), false);
  assertEquals(isPartialId("5ec_test"), false);
});

Deno.test("isPartialId is case insensitive", () => {
  assertEquals(isPartialId("ABC"), true);
  assertEquals(isPartialId("5EC"), true);
  assertEquals(isPartialId("AbC"), true);
});

// matchByPartialId tests

Deno.test("matchByPartialId returns found for single match", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "7abc123d-1234-5678-9abc-def012345678", item: "item2" },
  ];

  const result = matchByPartialId(items, "5ec");
  assertEquals(result.status, "found");
  if (result.status === "found") {
    assertEquals(result.match, "item1");
  }
});

Deno.test("matchByPartialId returns not_found when no match", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "7abc123d-1234-5678-9abc-def012345678", item: "item2" },
  ];

  const result = matchByPartialId(items, "999");
  assertEquals(result.status, "not_found");
});

Deno.test("matchByPartialId returns ambiguous when multiple matches", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "5ecf8b2c-1234-5678-9abc-def012345678", item: "item2" },
    { id: "7abc123d-1234-5678-9abc-def012345678", item: "item3" },
  ];

  const result = matchByPartialId(items, "5ec");
  assertEquals(result.status, "ambiguous");
  if (result.status === "ambiguous") {
    assertEquals(result.matches.length, 2);
    assertEquals(result.matches[0].id, "5ece291a-46c0-4fe2-8a1b-123456789abc");
    assertEquals(result.matches[1].id, "5ecf8b2c-1234-5678-9abc-def012345678");
  }
});

Deno.test("matchByPartialId is case insensitive", () => {
  const items = [
    { id: "5ECE291A-46C0-4FE2-8A1B-123456789ABC", item: "item1" },
  ];

  const result = matchByPartialId(items, "5ece");
  assertEquals(result.status, "found");
});

Deno.test("matchByPartialId ignores dashes in partial ID", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
  ];

  // Partial ID with dashes should still match
  const result = matchByPartialId(items, "5ece-291a");
  assertEquals(result.status, "found");
});

Deno.test("matchByPartialId matches full UUID", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "5ecf8b2c-1234-5678-9abc-def012345678", item: "item2" },
  ];

  const result = matchByPartialId(
    items,
    "5ece291a-46c0-4fe2-8a1b-123456789abc",
  );
  assertEquals(result.status, "found");
  if (result.status === "found") {
    assertEquals(result.match, "item1");
  }
});

// findDefinitionByIdOrName tests

Deno.test("findDefinitionByIdOrName finds definition by name", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "my-model",
      version: 1,
      tags: {},
      globalArguments: { message: "hello" },
    });
    await repo.save(type, definition);

    const result = await findDefinitionByIdOrName(repo, "my-model");

    assertEquals(result?.definition.id, definition.id);
    assertEquals(result?.definition.name, "my-model");
    assertEquals(result?.type.normalized, "swamp/echo");
  });
});

Deno.test("findDefinitionByIdOrName finds definition by UUID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "my-model",
      version: 1,
      tags: {},
      globalArguments: { message: "hello" },
    });
    await repo.save(type, definition);

    const result = await findDefinitionByIdOrName(repo, definition.id);

    assertEquals(result?.definition.id, definition.id);
    assertEquals(result?.definition.name, "my-model");
    assertEquals(result?.type.normalized, "swamp/echo");
  });
});

Deno.test("findDefinitionByIdOrName returns null when not found", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    const result = await findDefinitionByIdOrName(repo, "nonexistent");

    assertEquals(result, null);
  });
});

Deno.test("findDefinitionByIdOrName prefers name match over ID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("swamp/echo");

    // Create two definitions - one with a name that happens to be a UUID-like string
    const def1 = Definition.create({
      name: "abc123",
      version: 1,
      tags: {},
      globalArguments: {},
    });
    const def2 = Definition.create({
      name: "other-model",
      version: 1,
      tags: {},
      globalArguments: {},
    });
    await repo.save(type, def1);
    await repo.save(type, def2);

    // Looking up by name should find def1
    const result = await findDefinitionByIdOrName(repo, "abc123");

    assertEquals(result?.definition.name, "abc123");
  });
});
