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
import { ensureDir } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import {
  type CatalogRow,
  CatalogStore,
} from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import {
  clearCatalogSurplus,
  compareCatalogToDisk,
} from "../src/cli/commands/doctor_datastores.ts";
import {
  repairCatalogIndex,
  type RepairCatalogIndexEvent,
} from "../src/libswamp/datastores/doctor_datastores.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";

const OLD_TYPE = ModelType.create("@williamjtlacroix/es-events");
const NAMES = ["alpha", "beta", "gamma"];

function foreignRow(): CatalogRow {
  return {
    id: crypto.randomUUID(),
    namespace: "team",
    type_normalized: "@team/shared",
    model_id: "model-001",
    model_name: "shared",
    data_name: "pulled",
    version: 1,
    is_latest: 1,
    is_step_latest: 1,
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    garbage_collection: "10",
    lifecycle: "active",
    owner_type: "model-method",
    owner_ref: "test",
    streaming: 0,
    size: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
  };
}

async function withMovedType(
  fn: (r: {
    swampDir: string;
    catalog: CatalogStore;
    repo: FileSystemUnifiedDataRepository;
    query: DataQueryService;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-doctor-surplus-" });
  const swampDir = join(dir, ".swamp");
  const catalog = new CatalogStore(join(swampDir, "data", "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const query = new DataQueryService(catalog, repo);
  try {
    const modelId = crypto.randomUUID();
    for (const name of NAMES) {
      for (let i = 1; i <= 2; i++) {
        await repo.save(
          OLD_TYPE,
          modelId,
          Data.create({
            name,
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 10,
            tags: { type: "resource", modelName: "events" },
            ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
          }),
          new TextEncoder().encode(JSON.stringify({ i })),
        );
      }
    }
    await query.query("true");
    catalog.bulkUpsertForeign("team", [foreignRow()]);

    const dataDir = join(swampDir, "data");
    await ensureDir(join(dataDir, "@liywjl"));
    await Deno.rename(
      join(dataDir, "@williamjtlacroix", "es-events"),
      join(dataDir, "@liywjl", "es-events"),
    );
    catalog.invalidate();
    await query.query("true");

    await fn({ swampDir, catalog, repo, query });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("doctor datastores repair: a type moved by hand queries once per item after the surplus is cleared, keeping foreign rows and the populated catalog", async () => {
  await withMovedType(async ({ swampDir, catalog, repo, query }) => {
    const localNames = async () =>
      ((await query.query("true")) as DataRecord[])
        .filter((r) => r.namespace === SOLO_NAMESPACE)
        .map((r) => `${r.modelType}/${r.name}`)
        .sort();

    assertEquals((await localNames()).length, NAMES.length * 2);

    const events = await collect<RepairCatalogIndexEvent>(
      repairCatalogIndex(
        createLibSwampContext(),
        {
          checkCompleteness: () =>
            compareCatalogToDisk(catalog, repo, SOLO_NAMESPACE, {
              surplus: true,
            }),
          invalidateCatalog: () =>
            Promise.reject(new Error("a surplus alone must not rebuild")),
          clearSurplus: () =>
            clearCatalogSurplus(
              {
                catalogStore: catalog,
                dataRepo: repo,
                namespace: SOLO_NAMESPACE,
              },
              { type: "filesystem", path: swampDir },
            ),
        },
        { confirm: true },
      ),
    );

    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind !== "completed") {
      throw new Error(`repair did not complete: ${JSON.stringify(events)}`);
    }
    assertEquals(completed.result.mode, "clear");
    assertEquals(completed.result.surplus, [
      {
        typeNormalized: OLD_TYPE.normalized,
        dataNames: NAMES.length,
        catalogRecords: NAMES.length * 2,
      },
    ]);

    assertEquals(
      await localNames(),
      NAMES.map((n) => `@liywjl/es-events/${n}`),
    );
    assertEquals(catalog.isPopulated(), true);
    assertEquals(
      catalog.dataNameCounts("team").map((n) => n.data_name),
      ["pulled"],
    );

    const again = await compareCatalogToDisk(catalog, repo, SOLO_NAMESPACE, {
      surplus: true,
    });
    assertEquals(again.surplus, []);
    assertEquals(again.shortfalls, []);
  });
});
