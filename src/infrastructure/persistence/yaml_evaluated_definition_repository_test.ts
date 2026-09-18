// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { YamlEvaluatedDefinitionRepository } from "./yaml_evaluated_definition_repository.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";

const testType = ModelType.create("test/model");

function toCleanYaml(data: Record<string, unknown>): string {
  return stringifyYaml(JSON.parse(JSON.stringify(data)));
}

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-yaml-evaluated-definition-",
  });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test(
  "YamlEvaluatedDefinitionRepository invokes markDirty with relPath on mutations",
  async () => {
    await withTempDir(async (dir) => {
      const calls: Array<string | undefined> = [];
      const markDirty = (relPath?: string) => {
        calls.push(relPath);
        return Promise.resolve();
      };
      const repo = new YamlEvaluatedDefinitionRepository(
        dir,
        undefined,
        markDirty,
      );

      const definition = Definition.create({
        type: testType.normalized,
        typeVersion: "1",
        name: "test-def",
      });

      // save → per-definition yaml path (name-based for kebab-case names)
      await repo.save(testType, definition);
      assertEquals(calls.length, 1);
      const savedPath = repo.getPath(testType, definition.id);
      assertEquals(calls[0], savedPath);

      // delete → notifies with the resolved path
      await repo.delete(testType, definition.id);
      assertEquals(calls.length, 2);

      // Reads do not notify.
      await repo.findAll(testType);
      await repo.findById(testType, definition.id);
      assertEquals(calls.length, 2);

      // clearAll → baseDir path (whole evaluated-definitions tree removed)
      await repo.save(testType, definition);
      assertEquals(calls.length, 3);
      await repo.clearAll();
      assertEquals(calls.length, 4);
      assertEquals(
        calls[3],
        join(dir, ".swamp", "definitions-evaluated"),
      );
    });
  },
);

Deno.test("YamlEvaluatedDefinitionRepository.save writes name-based filename", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "my-eval-def",
    });

    await repo.save(testType, definition);

    // File should be at {name}.yaml
    const path = repo.getPath(testType, definition.id);
    assertStringIncludes(path, "my-eval-def.yaml");

    // findById should return it
    const loaded = await repo.findById(testType, definition.id);
    assertNotEquals(loaded, null);
    assertEquals(loaded!.name, "my-eval-def");
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.save migrates UUID file to name-based", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "migrate-eval",
    });

    // Manually write a UUID-named file (simulating legacy)
    const typeDir = join(
      dir,
      ".swamp",
      "definitions-evaluated",
      testType.toDirectoryPath(),
    );
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${definition.id}.yaml`);
    const data = definition.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(uuidPath, toCleanYaml(data));

    // Load and re-save — should migrate
    const loaded = await repo.findById(testType, definition.id);
    assertNotEquals(loaded, null);
    await repo.save(testType, loaded!);

    // Name-based file should exist
    const namePath = join(typeDir, "migrate-eval.yaml");
    const stat = await Deno.stat(namePath);
    assertEquals(stat.isFile, true);

    // UUID file should be gone
    try {
      await Deno.stat(uuidPath);
      assertEquals(true, false, "UUID file should have been removed");
    } catch (error) {
      assertEquals(error instanceof Deno.errors.NotFound, true);
    }
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.findByName fast path works", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "find-by-name",
    });

    await repo.save(testType, definition);

    const found = await repo.findByName(testType, "find-by-name");
    assertNotEquals(found, null);
    assertEquals(found!.id, definition.id);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.findByName falls through when file name diverges", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "actual-name",
    });

    await repo.save(testType, definition);

    // Rename file on disk but keep content name as "actual-name"
    const typeDir = join(
      dir,
      ".swamp",
      "definitions-evaluated",
      testType.toDirectoryPath(),
    );
    const namePath = join(typeDir, "actual-name.yaml");
    const wrongPath = join(typeDir, "wrong-name.yaml");
    await Deno.rename(namePath, wrongPath);

    // findByName("wrong-name") should fall through since content says "actual-name"
    const found = await repo.findByName(testType, "wrong-name");
    assertEquals(found, null);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.delete handles name-based files on cold cache", async () => {
  await withTempDir(async (dir) => {
    // Save with one repo instance
    const repo1 = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "cold-eval-delete",
    });
    await repo1.save(testType, definition);

    // Delete with a fresh instance (cold cache)
    const repo2 = new YamlEvaluatedDefinitionRepository(dir);
    await repo2.delete(testType, definition.id);

    assertEquals(await repo2.findById(testType, definition.id), null);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.clearAll also clears path cache", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "clear-cache",
    });

    await repo.save(testType, definition);
    assertNotEquals(await repo.findById(testType, definition.id), null);

    await repo.clearAll();
    assertEquals(await repo.findById(testType, definition.id), null);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: reloads provenance from name and UUID caches", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({ name: "provenance" });
    const authoredExpressions = new Set(["${{ env.HOME }}"]);
    await repo.save(testType, definition, authoredExpressions);
    const path = repo.getPath(testType, definition.id);
    const legacyPath = join(
      dir,
      ".swamp",
      "definitions-evaluated",
      testType.toDirectoryPath(),
      `${definition.id}.yaml`,
    );
    for (const legacy of [false, true]) {
      if (legacy) await Deno.rename(path, legacyPath);
      const fresh = new YamlEvaluatedDefinitionRepository(dir);
      const cached = await fresh.findByNameWithProvenance(
        testType,
        definition.name,
      );
      assertEquals(cached?.authoredExpressions, authoredExpressions);
      assertEquals(
        cached?.definition.toData(),
        (await fresh.findByName(testType, definition.name))?.toData(),
      );
      assertEquals(
        Object.hasOwn(cached!.definition.toData(), "authoredExpressions"),
        false,
      );
    }
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: replacing a cache replaces its provenance", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({ name: "provenance" });
    await repo.save(testType, definition, new Set(["${{ env.OLD }}"]));
    for (
      const authored of [
        new Set(["${{ env.NEW }}"]),
        new Set<string>(),
        undefined,
      ]
    ) {
      await repo.save(testType, definition, authored);
      const cached = await new YamlEvaluatedDefinitionRepository(dir)
        .findByNameWithProvenance(testType, definition.name);
      assertEquals(cached?.authoredExpressions, authored ?? new Set());
      assertEquals(cached?.deferredExpressions, []);
    }
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: rejects malformed provenance", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({ name: "provenance" });
    await repo.save(testType, definition);
    const path = repo.getPath(testType, definition.id);
    for (
      const authoredExpressions of [null, "${{ env.HOME }}", {}, [42], [
        "${{ env.HOME }}",
        false,
      ]]
    ) {
      await Deno.writeTextFile(
        path,
        toCleanYaml({ ...definition.toData(), authoredExpressions }),
      );
      await assertRejects(() =>
        new YamlEvaluatedDefinitionRepository(dir).findByNameWithProvenance(
          testType,
          definition.name,
        )
      );
    }
  });
});
