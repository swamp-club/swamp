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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";

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

/** Serialize definition data to YAML, stripping undefined values like save() does. */
function toCleanYaml(data: Record<string, unknown>): string {
  return stringifyYaml(JSON.parse(JSON.stringify(data)));
}

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
    const typeDir = join(dir, "models", testType.toDirectoryPath());
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
    const typeDir = join(dir, "models", testType.toDirectoryPath());
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
    const typeDir = join(dir, "models", testType.toDirectoryPath());
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
    const typeDir = join(dir, "models", testType.toDirectoryPath());
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

Deno.test("YamlDefinitionRepository.findAll discovers symlinked YAML files targeting outside models/", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("real-def");

    // Save a real definition first
    await repo.save(testType, definition);

    // Simulate legacy layout: real file lives in .swamp/definitions/ (inside repo,
    // outside models/), symlinked into models/
    const secondDef = createTestDefinition("legacy-def");
    const legacyDir = join(
      dir,
      ".swamp",
      "definitions",
      testType.toDirectoryPath(),
    );
    await ensureDir(legacyDir);
    const realFile = join(legacyDir, `${secondDef.id}.yaml`);
    const data = secondDef.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(realFile, toCleanYaml(data));

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await Deno.symlink(realFile, join(typeDir, `${secondDef.id}.yaml`), {
      type: "file",
    });

    const results = await repo.findAll(testType);
    assertEquals(results.length, 2);
    const names = results.map((d) => d.name).sort();
    assertEquals(names, ["legacy-def", "real-def"]);
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal discovers symlinked YAML files targeting outside models/", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("real-def");
    await repo.save(testType, definition);

    // Simulate extension layout: real file in extensions/models/ (inside repo,
    // outside models/), symlinked into models/
    const symDef = createTestDefinition("ext-def");
    const extDir = join(
      dir,
      "extensions",
      "models",
      testType.toDirectoryPath(),
    );
    await ensureDir(extDir);
    const realFile = join(extDir, `${symDef.id}.yaml`);
    const data = symDef.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(realFile, toCleanYaml(data));

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await Deno.symlink(realFile, join(typeDir, `${symDef.id}.yaml`), {
      type: "file",
    });

    const results = await repo.findAllGlobal();
    assertEquals(results.length, 2);
    const names = results.map((r) => r.definition.name).sort();
    assertEquals(names, ["ext-def", "real-def"]);
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal discovers symlinked YAML files targeting outside models/", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    // Simulate extension layout: real file in extensions/models/, symlinked into models/
    const symDef = createTestDefinition("ext-find");
    const extDir = join(
      dir,
      "extensions",
      "models",
      testType.toDirectoryPath(),
    );
    await ensureDir(extDir);
    const realFile = join(extDir, `${symDef.id}.yaml`);
    const data = symDef.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(realFile, toCleanYaml(data));

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    await Deno.symlink(realFile, join(typeDir, `${symDef.id}.yaml`), {
      type: "file",
    });

    const result = await repo.findByNameGlobal("ext-find");
    assertNotEquals(result, null);
    assertEquals(result!.definition.name, "ext-find");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal uses YAML type field over path", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    // Create a definition with a type that differs from the directory path
    const def = Definition.create({
      name: "typed-def",
      type: "@smith/kibana-dev",
      globalArguments: { key: "value" },
    });

    // Save it under a directory that doesn't match the YAML type
    const typeDir = join(dir, "models", "kibana");
    await ensureDir(typeDir);
    const data = def.toData();
    data.type = "@smith/kibana-dev";
    await Deno.writeTextFile(
      join(typeDir, `${def.id}.yaml`),
      toCleanYaml(data),
    );

    const results = await repo.findAllGlobal();
    assertEquals(results.length, 1);
    assertEquals(results[0].type.normalized, "@smith/kibana-dev");
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal uses YAML type field over path", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    // Create a definition with a type that differs from the directory path
    const def = Definition.create({
      name: "typed-find",
      type: "@smith/kibana-dev",
      globalArguments: { key: "value" },
    });

    const typeDir = join(dir, "models", "kibana");
    await ensureDir(typeDir);
    const data = def.toData();
    data.type = "@smith/kibana-dev";
    await Deno.writeTextFile(
      join(typeDir, `${def.id}.yaml`),
      toCleanYaml(data),
    );

    const result = await repo.findByNameGlobal("typed-find");
    assertNotEquals(result, null);
    assertEquals(result!.type.normalized, "@smith/kibana-dev");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal falls back to path-based type when YAML type is missing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    // Create a definition without a type field in the YAML
    const def = Definition.create({
      name: "no-type-def",
      globalArguments: { key: "value" },
    });

    const typeDir = join(dir, "models", "test", "example");
    await ensureDir(typeDir);
    const data = def.toData();
    delete data.type;
    await Deno.writeTextFile(
      join(typeDir, `${def.id}.yaml`),
      toCleanYaml(data),
    );

    const results = await repo.findAllGlobal();
    assertEquals(results.length, 1);
    assertEquals(results[0].type.normalized, "test/example");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal resolves symlinked extension with scoped type", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    // Simulate the real issue #683 scenario: user has @smith/kibana-dev extension
    // installed. The definition YAML lives in extensions/models/ and is symlinked
    // into models/. The YAML type field says "@smith/kibana-dev" but the directory
    // path is just "kibana-dev".
    const def = Definition.create({
      name: "my-kibana",
      type: "@smith/kibana-dev",
      globalArguments: { host: "localhost" },
    });

    // Extension file lives in extensions/models/
    const extDir = join(dir, "extensions", "models", "kibana-dev");
    await ensureDir(extDir);
    const realFile = join(extDir, `${def.id}.yaml`);
    const data = def.toData();
    data.type = "@smith/kibana-dev";
    await Deno.writeTextFile(realFile, toCleanYaml(data));

    // Symlink into models/ under directory that doesn't match full scoped type
    const typeDir = join(dir, "models", "kibana-dev");
    await ensureDir(typeDir);
    await Deno.symlink(realFile, join(typeDir, `${def.id}.yaml`), {
      type: "file",
    });

    const results = await repo.findAllGlobal();
    assertEquals(results.length, 1);
    // Must use the YAML type "@smith/kibana-dev", not the path "kibana-dev"
    assertEquals(results[0].type.normalized, "@smith/kibana-dev");
    assertEquals(results[0].definition.name, "my-kibana");
  });
});

Deno.test("YamlDefinitionRepository.findAll rejects symlink pointing outside repo", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("good-def");
    await repo.save(testType, definition);

    // Create a symlink pointing completely outside the repo boundary
    const outsideDir = await Deno.makeTempDir();
    try {
      const outsideFile = join(outsideDir, "evil.yaml");
      const evilData = {
        id: crypto.randomUUID(),
        name: "evil-def",
        version: 1,
        tags: {},
        globalArguments: {},
        methods: {},
      };
      await Deno.writeTextFile(outsideFile, stringifyYaml(evilData));

      const typeDir = join(dir, "models", testType.toDirectoryPath());
      await Deno.symlink(outsideFile, join(typeDir, "evil.yaml"), {
        type: "file",
      });

      // Should only return the good definition, skipping the evil symlink
      const results = await repo.findAll(testType);
      assertEquals(results.length, 1);
      assertEquals(results[0].name, "good-def");
    } finally {
      await Deno.remove(outsideDir, { recursive: true });
    }
  });
});
