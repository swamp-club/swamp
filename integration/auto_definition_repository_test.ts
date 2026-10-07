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

// Auto-definitions (direct type execution) through the real model delete and
// model edit wiring: the shared definition repository must find, report,
// save and delete the file in .swamp/auto-definitions, by id or by name
// (swamp-club#2515).

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createModelDeleteDeps,
  modelDelete,
  modelDeletePreview,
} from "../src/libswamp/models/delete.ts";
import { createModelEditDeps, modelEdit } from "../src/libswamp/models/edit.ts";
import { createModelGetDeps, modelGet } from "../src/libswamp/models/get.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

await initializeLogging({});

const shellType = ModelType.create("command/shell");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Saves an auto-definition the way direct type execution does. */
async function saveAutoDefinition(
  repoDir: string,
  name: string,
): Promise<{ definition: Definition; path: string }> {
  const autoRepo = new YamlDefinitionRepository(
    repoDir,
    undefined,
    swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
    false,
  );
  const definition = Definition.create({
    name,
    type: shellType.normalized,
    globalArguments: {},
  });
  await autoRepo.save(shellType, definition);
  return { definition, path: autoRepo.getPath(shellType, definition.id) };
}

function deleteDeps(repoDir: string) {
  return createModelDeleteDeps(
    repoDir,
    undefined,
    new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(":memory:"),
    ),
  );
}

for (const by of ["uuid", "name"] as const) {
  Deno.test(`integration: model delete by ${by} removes an auto-definition and reports its path`, async () => {
    await withTempDir(async (repoDir) => {
      const { definition, path } = await saveAutoDefinition(
        repoDir,
        "auto-sh",
      );
      const modelIdOrName = by === "uuid" ? definition.id : definition.name;

      const preview = await modelDeletePreview(
        createLibSwampContext(),
        deleteDeps(repoDir),
        { modelIdOrName, force: true },
      );
      assertPathEquals(preview.definitionPath, path);

      let inputPath: string | undefined;
      for await (
        const event of modelDelete(
          createLibSwampContext(),
          deleteDeps(repoDir),
          { modelIdOrName, force: true },
        )
      ) {
        if (event.kind === "error") throw new Error(event.error.message);
        if (event.kind === "completed") inputPath = event.data.inputPath;
      }

      assertPathEquals(inputPath!, path);
      assertEquals(await fileExists(path), false);
    });
  });

  Deno.test(`integration: model edit by ${by} from stdin updates an auto-definition in place`, async () => {
    await withTempDir(async (repoDir) => {
      const { definition, path } = await saveAutoDefinition(
        repoDir,
        "auto-sh",
      );
      const modelIdOrName = by === "uuid" ? definition.id : definition.name;
      const edited = stringifyYaml({
        ...JSON.parse(JSON.stringify(definition.toData())),
        tags: { edited: "yes" },
      });

      let reportedPath: string | undefined;
      for await (
        const event of modelEdit(
          createLibSwampContext(),
          createModelEditDeps(repoDir),
          { modelIdOrName, stdinContent: edited },
        )
      ) {
        if (event.kind === "error") throw new Error(event.error.message);
        if (event.kind === "completed") reportedPath = event.data.path;
      }

      assertPathEquals(reportedPath!, path);
      assertEquals(await fileExists(join(repoDir, "models")), false);
      const reread = await new YamlDefinitionRepository(repoDir).findById(
        shellType,
        definition.id,
      );
      assertEquals(reread?.tags, { edited: "yes" });
    });
  });
}

async function getAutoCreated(
  repoDir: string,
  modelIdOrName: string,
): Promise<boolean | undefined> {
  for await (
    const event of modelGet(
      createLibSwampContext(),
      await createModelGetDeps(new YamlDefinitionRepository(repoDir)),
      modelIdOrName,
    )
  ) {
    if (event.kind === "error") throw new Error(event.error.message);
    if (event.kind === "completed") return event.data.autoCreated;
  }
  throw new Error("model get did not complete");
}

Deno.test("integration: model get flags an auto-definition by uuid and by name, and not a models/ one", async () => {
  await withTempDir(async (repoDir) => {
    const auto = await saveAutoDefinition(repoDir, "auto-sh");
    const authored = Definition.create({
      name: "authored",
      type: shellType.normalized,
      globalArguments: {},
    });
    await new YamlDefinitionRepository(repoDir, undefined, undefined, false)
      .save(shellType, authored);

    assertEquals(await getAutoCreated(repoDir, auto.definition.id), true);
    assertEquals(await getAutoCreated(repoDir, "auto-sh"), true);
    assertEquals(await getAutoCreated(repoDir, authored.id), undefined);
    assertEquals(await getAutoCreated(repoDir, "authored"), undefined);
  });
});

Deno.test("integration: model delete by uuid of an auto-definition leaves a same-named models/ definition", async () => {
  await withTempDir(async (repoDir) => {
    const auto = await saveAutoDefinition(repoDir, "shared-name");
    const primaryRepo = new YamlDefinitionRepository(
      repoDir,
      undefined,
      undefined,
      false,
    );
    const authored = Definition.create({
      name: "shared-name",
      type: shellType.normalized,
      globalArguments: {},
    });
    await primaryRepo.save(shellType, authored);
    const authoredPath = primaryRepo.getPath(shellType, authored.id);

    for await (
      const event of modelDelete(
        createLibSwampContext(),
        deleteDeps(repoDir),
        { modelIdOrName: auto.definition.id, force: true },
      )
    ) {
      if (event.kind === "error") throw new Error(event.error.message);
    }

    assertEquals(await fileExists(auto.path), false);
    assertEquals(await fileExists(authoredPath), true);
  });
});
