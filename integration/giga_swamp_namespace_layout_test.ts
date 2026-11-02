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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import {
  catalogDbPath,
  namespaceFromResolver,
} from "../src/infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-giga-layout-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const type = ModelType.create("test/model");

function makeData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: "ingest", specName: "result" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:m",
    },
  });
}

async function writeOneItem(
  repoDir: string,
  config: DatastoreConfig,
): Promise<{
  modelId: string;
  dataBaseDir: string;
  catalogPath: string;
  rows: DataRecord[];
}> {
  const resolver = new DefaultDatastorePathResolver(repoDir, config);
  const dataBaseDir = resolver.resolvePath("data");
  const catalogPath = catalogDbPath(repoDir, resolver);
  const modelId = crypto.randomUUID();

  const catalog = new CatalogStore(catalogPath);
  try {
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      dataBaseDir,
      catalog,
      undefined,
      undefined,
      namespaceFromResolver(resolver),
    );
    await repo.save(
      type,
      modelId,
      makeData("alpha"),
      new TextEncoder().encode('{"k":1}'),
    );
    const service = new DataQueryService(catalog, repo);
    const rows = await service.query('modelName == "ingest"') as DataRecord[];
    return { modelId, dataBaseDir, catalogPath, rows };
  } finally {
    catalog.close();
  }
}

Deno.test("giga-swamp layout: namespaced repo lands data under {ds}/{namespace}/data and stamps the namespace", async () => {
  await withTempDir(async (repoDir) => {
    const dsDir = join(repoDir, "external-ds");
    const config: DatastoreConfig = {
      type: "filesystem",
      path: dsDir,
      namespace: "infra",
    };

    const { modelId, dataBaseDir, catalogPath, rows } = await writeOneItem(
      repoDir,
      config,
    );

    assertEquals(dataBaseDir, join(dsDir, "infra", "data"));
    assertEquals(
      existsSync(join(dsDir, "infra", "data", type.normalized, modelId)),
      true,
    );
    assertEquals(existsSync(join(dsDir, "data")), false);

    assertEquals(catalogPath, join(repoDir, ".swamp", "data", "_catalog.db"));
    assertEquals(existsSync(catalogPath), true);
    assertEquals(
      existsSync(join(dsDir, "infra", "data", "_catalog.db")),
      false,
    );

    assertEquals(rows.length, 1);
    assertEquals(rows[0].namespace, "infra");
  });
});

Deno.test("giga-swamp layout: solo mode is byte-identical (data in {ds}/data, repo-local catalog)", async () => {
  await withTempDir(async (repoDir) => {
    const dsDir = join(repoDir, "external-ds");
    const config: DatastoreConfig = { type: "filesystem", path: dsDir };

    const { modelId, dataBaseDir, catalogPath, rows } = await writeOneItem(
      repoDir,
      config,
    );

    assertEquals(dataBaseDir, join(dsDir, "data"));
    assertEquals(
      existsSync(join(dsDir, "data", type.normalized, modelId)),
      true,
    );
    assertEquals(catalogPath, join(repoDir, ".swamp", "data", "_catalog.db"));
    assertEquals(existsSync(catalogPath), true);

    assertEquals(rows.length, 1);
    assertEquals(rows[0].namespace, "");
  });
});

Deno.test("giga-swamp layout: two namespaces sharing a datastore keep data and catalogs separate", async () => {
  await withTempDir(async (root) => {
    const dsDir = join(root, "shared-ds");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");

    const a = await writeOneItem(repoA, {
      type: "filesystem",
      path: dsDir,
      namespace: "infra",
    });
    const b = await writeOneItem(repoB, {
      type: "filesystem",
      path: dsDir,
      namespace: "security",
    });

    assertEquals(
      existsSync(join(dsDir, "infra", "data", type.normalized, a.modelId)),
      true,
    );
    assertEquals(
      existsSync(join(dsDir, "security", "data", type.normalized, b.modelId)),
      true,
    );

    assertEquals(a.catalogPath, join(repoA, ".swamp", "data", "_catalog.db"));
    assertEquals(b.catalogPath, join(repoB, ".swamp", "data", "_catalog.db"));
    assertEquals(a.catalogPath === b.catalogPath, false);

    assertEquals(a.rows.map((r) => r.namespace), ["infra"]);
    assertEquals(b.rows.map((r) => r.namespace), ["security"]);
  });
});
