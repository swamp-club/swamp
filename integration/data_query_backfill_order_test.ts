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
 * A catalog backfill inserts rows in the repository's walk order, and
 * queries iterate by rowid. The walk is in name order at every level, so
 * the first query on an unpopulated catalog leaves rows in data-name order
 * on every filesystem, not in the order readdir happened to return
 * (swamp-club#3066). The repository, catalog and query service are opened
 * as repo_context opens them for the CLI.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Data } from "../src/domain/data/data.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

const modelType = ModelType.create("test/query-backfill-order");
const MODEL_ID = "backfill-order-model";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-query-backfill-order-" });
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

Deno.test("data query: a catalog backfill leaves rows in data-name order", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir, { recursive: true });
    const homeDir = join(repoDir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });

    const ctx = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    try {
      const dataRepo = ctx.repoContext.unifiedDataRepo;
      for (const name of ["c", "a", "b"]) {
        await dataRepo.save(
          modelType,
          MODEL_ID,
          Data.create({
            name,
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 10,
            tags: { type: "resource", modelName: "backfill-order" },
            ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
          }),
          new TextEncoder().encode(`{"name":"${name}"}`),
        );
      }

      const catalogStore = ctx.repoContext.catalogStore;
      assertEquals(catalogStore.isPopulated(), false);
      const results = await ctx.repoContext.dataQueryService.query(
        'modelName == "backfill-order"',
      );
      assertEquals(
        (results as DataRecord[]).map((r) => r.name),
        ["a", "b", "c"],
      );
      assertEquals(catalogStore.isPopulated(), true);

      const rows = [...catalogStore.iterate()]
        .filter((row) => row.model_id === MODEL_ID)
        .map((row) => row.data_name);
      assertEquals(rows, ["a", "b", "c"]);
    } finally {
      ctx.repoContext.catalogStore.close();
    }
  });
});
