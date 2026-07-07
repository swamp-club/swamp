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

/**
 * Integration tests for orphaned-data reclamation (`swamp data prune`),
 * reproducing swamp-club#1009.
 *
 * Exercises the full slice against a real FileSystemUnifiedDataRepository +
 * CatalogStore + YamlDefinitionRepository:
 * (a) data whose owning model definition is gone is reclaimed (disk + catalog)
 * (b) a model with a live definition is never touched (no false positives)
 * (c) a model whose definition lives ONLY in .swamp/auto-definitions/ is treated
 *     as live and never pruned — the ADV-1 correctness crux: the predicate must
 *     match `swamp model get` (findById covers models/ AND auto-definitions/),
 *     not `model search` (which skips auto-definitions)
 * (d) --dry-run reports the orphan but deletes nothing
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import type { OwnerDefinition } from "../src/domain/data/data_metadata.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  createDefinitionId,
  Definition,
} from "../src/domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  DefaultDataLifecycleService,
  type IsModelLive,
} from "../src/domain/data/data_lifecycle_service.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-prune-" });
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

function createOwner(ref: string): OwnerDefinition {
  return { ownerType: "model-method", ownerRef: ref };
}

// A stub workflow-run repo — orphan reclamation never consults it.
const stubWorkflowRunRepo = { findById: () => Promise.resolve(null) } as never;

interface Harness {
  service: DefaultDataLifecycleService;
  dataRepo: FileSystemUnifiedDataRepository;
  isModelLive: IsModelLive;
  /** Definition repo scoped to models/ (primary). */
  modelsRepo: YamlDefinitionRepository;
  /** Definition repo scoped to .swamp/auto-definitions/ (secondary). */
  autoDefsRepo: YamlDefinitionRepository;
}

async function wire(repoDir: string): Promise<Harness> {
  await ensureDir(join(repoDir, ".swamp", "data"));
  await ensureDir(join(repoDir, "models"));

  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    undefined,
    new CatalogStore(join(repoDir, "_catalog.db")),
  );
  const service = new DefaultDataLifecycleService(
    dataRepo,
    stubWorkflowRunRepo,
  );

  // Predicate wired exactly like createDataPruneDeps: per-item findById on a
  // repo that resolves BOTH models/ and .swamp/auto-definitions/.
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const isModelLive: IsModelLive = async (type, modelId) =>
    (await definitionRepo.findById(type, createDefinitionId(modelId))) !== null;

  const modelsRepo = new YamlDefinitionRepository(repoDir);
  const autoDefsRepo = new YamlDefinitionRepository(
    repoDir,
    undefined,
    swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
  );

  return { service, dataRepo, isModelLive, modelsRepo, autoDefsRepo };
}

async function writeData(
  dataRepo: FileSystemUnifiedDataRepository,
  type: ModelType,
  modelId: string,
  dataName: string,
  versions: number,
): Promise<void> {
  const data = Data.create({
    name: dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "state", modelName: "test-model" },
    ownerDefinition: createOwner(`${type.toDirectoryPath()}:${modelId}`),
  });
  for (let i = 1; i <= versions; i++) {
    await dataRepo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ v: i })),
    );
  }
}

Deno.test("Data Prune: reclaims orphaned data, spares live and auto-definition models", async () => {
  await withTempDir(async (repoDir) => {
    const { service, dataRepo, isModelLive, modelsRepo, autoDefsRepo } =
      await wire(repoDir);

    const type = ModelType.create("test/prune");

    // 1. LIVE model — definition saved to models/
    const live = Definition.create({ name: "live-model" });
    await modelsRepo.save(type, live);
    await writeData(dataRepo, type, live.id, "state", 2);

    // 2. AUTO-DEF model — definition saved ONLY to .swamp/auto-definitions/
    const auto = Definition.create({ name: "auto-model" });
    await autoDefsRepo.save(type, auto);
    await writeData(dataRepo, type, auto.id, "state", 2);

    // 3. ORPHAN model — data written, but NO definition anywhere
    const orphanId = createDefinitionId(crypto.randomUUID());
    await writeData(dataRepo, type, orphanId, "result", 3);

    // findOrphanedData returns exactly the orphan.
    const orphans = await service.findOrphanedData(isModelLive);
    assertEquals(orphans.length, 1);
    assertEquals(orphans[0].modelId, orphanId);
    assertEquals(orphans[0].versionCount, 3);

    // --dry-run: nothing deleted.
    const dry = await service.deleteOrphanedData({ isModelLive, dryRun: true });
    assertEquals(dry.modelsReclaimed, 1);
    assertEquals(dry.dryRun, true);
    assertEquals(
      (await dataRepo.listVersions(type, orphanId, "result")).length,
      3,
    );

    // Real prune: orphan gone, live + auto-def intact.
    const result = await service.deleteOrphanedData({ isModelLive });
    assertEquals(result.modelsReclaimed, 1);
    assertEquals(result.dataEntriesReclaimed, 1);
    assertEquals(result.versionsDeleted, 3);
    assertEquals(result.bytesReclaimed > 0, true);

    // Orphan removed from disk AND catalog.
    assertEquals(await dataRepo.listVersions(type, orphanId, "result"), []);
    assertEquals(await dataRepo.findByName(type, orphanId, "result"), null);

    // Invariant (b): live model untouched.
    assertEquals(
      (await dataRepo.listVersions(type, live.id, "state")).length,
      2,
    );
    // Invariant (c) — ADV-1: auto-definition-backed model untouched.
    assertEquals(
      (await dataRepo.listVersions(type, auto.id, "state")).length,
      2,
    );
  });
});

Deno.test("Data Prune: no orphans when every model has a live definition", async () => {
  await withTempDir(async (repoDir) => {
    const { service, dataRepo, isModelLive, modelsRepo } = await wire(repoDir);
    const type = ModelType.create("test/prune");

    const live = Definition.create({ name: "live-only" });
    await modelsRepo.save(type, live);
    await writeData(dataRepo, type, live.id, "state", 2);

    const result = await service.deleteOrphanedData({ isModelLive });
    assertEquals(result.modelsReclaimed, 0);
    assertEquals(
      (await dataRepo.listVersions(type, live.id, "state")).length,
      2,
    );
  });
});
