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

/**
 * Integration tests for swamp data delete.
 *
 * Exercises the full slice against a real FileSystemUnifiedDataRepository:
 * (a) full-artifact delete removes directory + catalog row
 * (b) --version delete removes only that version, updates latest pointer
 * (c) missing artifact surfaces as a clear error
 * (d) --version against non-existent version names available versions
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import type { OwnerDefinition } from "../src/domain/data/data_metadata.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataDeleteService } from "../src/domain/data/data_delete_service.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-delete-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles
      // yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, "models"));
}

function createOwner(ref: string): OwnerDefinition {
  return { ownerType: "model-method", ownerRef: ref };
}

interface Wired {
  service: DataDeleteService;
  dataRepo: FileSystemUnifiedDataRepository;
  type: ModelType;
  modelId: string;
}

async function wireService(repoDir: string): Promise<Wired> {
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    undefined,
    new CatalogStore(join(repoDir, "_catalog.db")),
  );
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const type = ModelType.create("test/delete");
  const definition = Definition.create({ name: "delete-target" });
  await definitionRepo.save(type, definition);
  const service = new DataDeleteService(dataRepo, definitionRepo);
  return { service, dataRepo, type, modelId: definition.id };
}

async function writeVersions(
  dataRepo: FileSystemUnifiedDataRepository,
  type: ModelType,
  modelId: string,
  dataName: string,
  count: number,
): Promise<void> {
  const data = Data.create({
    name: dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "state" },
    ownerDefinition: createOwner("test/delete:writeVersions"),
  });
  for (let i = 1; i <= count; i++) {
    await dataRepo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ v: i })),
    );
  }
}

Deno.test("Data Delete: full-artifact delete removes directory and catalog row", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const { service, dataRepo, type, modelId } = await wireService(repoDir);

    await writeVersions(dataRepo, type, modelId, "stale-state", 3);

    // Sanity: 3 versions, latest points to v3
    const before = await dataRepo.listVersions(type, modelId, "stale-state");
    assertEquals(before, [1, 2, 3]);
    const beforeLatest = await dataRepo.findByName(
      type,
      modelId,
      "stale-state",
    );
    assertEquals(beforeLatest?.version, 3);

    const result = await service.delete("delete-target", "stale-state");

    assertEquals(result.versionsDeleted, 3);
    assertEquals(result.version, undefined);

    // Directory gone
    const after = await dataRepo.listVersions(type, modelId, "stale-state");
    assertEquals(after, []);
    // Catalog reflects removal
    const afterLookup = await dataRepo.findByName(
      type,
      modelId,
      "stale-state",
    );
    assertEquals(afterLookup, null);
  });
});

Deno.test("Data Delete: --version removes only that version, latest follows", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const { service, dataRepo, type, modelId } = await wireService(repoDir);

    await writeVersions(dataRepo, type, modelId, "rollback", 3);

    const result = await service.delete("delete-target", "rollback", 2);

    assertEquals(result.versionsDeleted, 1);
    assertEquals(result.version, 2);

    // Versions 1 and 3 remain, version 2 is gone
    const remaining = await dataRepo.listVersions(type, modelId, "rollback");
    assertEquals(remaining.sort((a, b) => a - b), [1, 3]);

    // Latest still points to 3 (the highest remaining version)
    const latest = await dataRepo.findByName(type, modelId, "rollback");
    assertExists(latest);
    assertEquals(latest.version, 3);
  });
});

Deno.test("Data Delete: missing artifact throws a clear error", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const { service } = await wireService(repoDir);

    await assertRejects(
      () => service.delete("delete-target", "never-existed"),
      Error,
      'No data named "never-existed" exists for model delete-target',
    );
  });
});

Deno.test("Data Delete: --version against non-existent version names available versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const { service, dataRepo, type, modelId } = await wireService(repoDir);

    await writeVersions(dataRepo, type, modelId, "partial", 3);

    const error = await assertRejects(
      () => service.delete("delete-target", "partial", 99),
      Error,
    );
    // Message must name the available versions so the user knows what to pick
    assertEquals(
      error.message.includes('Version 99 does not exist for "partial"'),
      true,
    );
    assertEquals(
      error.message.includes("available versions: 1, 2, 3"),
      true,
    );

    // No versions were removed by the failed attempt
    const after = await dataRepo.listVersions(type, modelId, "partial");
    assertEquals(after.sort((a, b) => a - b), [1, 2, 3]);
  });
});
