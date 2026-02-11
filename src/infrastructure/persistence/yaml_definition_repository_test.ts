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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

function createTestDefinition(name: string): Definition {
  return Definition.create({
    name,
    globalArguments: { key: "value" },
  });
}

const testType = ModelType.create("test/example");

Deno.test("YamlDefinitionRepository.save and findById roundtrip", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("test-def");

    await repo.save(testType, definition);
    const loaded = await repo.findById(testType, definition.id);

    assertNotEquals(loaded, null);
    assertEquals(loaded!.id, definition.id);
    assertEquals(loaded!.name, definition.name);
  });
});

Deno.test("YamlDefinitionRepository.findAll skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");

    await repo.save(testType, goodDef);

    // Write a broken YAML file in the same type directory
    const typeDir = swampPath(
      dir,
      SWAMP_SUBDIRS.definitions,
      testType.toDirectoryPath(),
    );
    await Deno.writeTextFile(
      join(typeDir, "broken.yaml"),
      "this: is: not: valid: yaml: [",
    );

    const results = await repo.findAll(testType);

    // Should return the good definition and skip the broken one
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "good-def");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");

    await repo.save(testType, goodDef);

    // Write a broken YAML file in the same type directory
    const typeDir = swampPath(
      dir,
      SWAMP_SUBDIRS.definitions,
      testType.toDirectoryPath(),
    );
    await Deno.writeTextFile(
      join(typeDir, "broken.yaml"),
      "not valid yaml content {{{",
    );

    const results = await repo.findAllGlobal();

    // Should return the good definition and skip the broken one
    assertEquals(results.length, 1);
    assertEquals(results[0].definition.name, "good-def");
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");

    await repo.save(testType, goodDef);

    // Write a broken YAML file in the same type directory
    const typeDir = swampPath(
      dir,
      SWAMP_SUBDIRS.definitions,
      testType.toDirectoryPath(),
    );
    await Deno.writeTextFile(
      join(typeDir, "broken.yaml"),
      "not valid yaml content {{{",
    );

    // Should still find the good definition despite the broken file
    const result = await repo.findByNameGlobal("good-def");
    assertNotEquals(result, null);
    assertEquals(result!.definition.name, "good-def");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal skips schema-invalid YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");

    await repo.save(testType, goodDef);

    // Write a valid YAML file that fails schema validation (missing required fields)
    const typeDir = swampPath(
      dir,
      SWAMP_SUBDIRS.definitions,
      testType.toDirectoryPath(),
    );
    const invalidData = { description: "no name or id field" };
    await Deno.writeTextFile(
      join(typeDir, "invalid-schema.yaml"),
      stringifyYaml(invalidData),
    );

    const results = await repo.findAllGlobal();

    // Should return only the good definition
    assertEquals(results.length, 1);
    assertEquals(results[0].definition.name, "good-def");
  });
});

Deno.test("YamlDefinitionRepository.findAll returns empty for no definitions", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    const all = await repo.findAll(testType);
    assertEquals(all, []);
  });
});

Deno.test("YamlDefinitionRepository.delete removes definition", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("to-delete");

    await repo.save(testType, definition);
    assertEquals((await repo.findById(testType, definition.id)) !== null, true);

    await repo.delete(testType, definition.id);
    assertEquals(await repo.findById(testType, definition.id), null);
  });
});
