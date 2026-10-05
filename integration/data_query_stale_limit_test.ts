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
 * A limited `data query` counts only records that survive the stale-row
 * check (swamp-club#2985). The repository, catalog and query service are
 * opened as repo_context opens them for the CLI, and the libswamp dataQuery
 * generator derives `limited` from the count the service returns, so a stale
 * catalog row (backing file deleted) must neither shorten the page nor make
 * a full page read as complete.
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
import {
  collect,
  createLibSwampContext,
  dataQuery,
  type DataQueryEvent,
} from "../src/libswamp/mod.ts";

await initializeLogging({});

const modelType = ModelType.create("test/query-stale-limit");
const MODEL_ID = "stale-limit-model";
const PREDICATE = 'modelName == "stale-limit" && dataType == "resource"';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-query-stale-limit-" });
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

Deno.test("data query: a stale catalog row neither shortens a limited page nor hides that it is full", async () => {
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
      for (const name of ["stale", "a", "b"]) {
        await dataRepo.save(
          modelType,
          MODEL_ID,
          Data.create({
            name,
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 10,
            tags: { type: "resource", modelName: "stale-limit" },
            ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
          }),
          new TextEncoder().encode(`{"name":"${name}"}`),
        );
      }
      // The catalog row stays; only its backing file goes.
      await Deno.remove(
        dataRepo.getContentPath(modelType, MODEL_ID, "stale", 1),
      );

      const queryService = ctx.repoContext.dataQueryService;
      const run = async (limit: number) => {
        const events = await collect<DataQueryEvent>(
          dataQuery(
            createLibSwampContext(),
            { query: (p, opts) => queryService.query(p, opts) },
            { predicate: PREDICATE, limit },
          ),
        );
        const last = events.at(-1)!;
        if (last.kind !== "completed") {
          throw new Error(`query did not complete: ${JSON.stringify(last)}`);
        }
        return {
          names: (last.data.results as DataRecord[]).map((r) => r.name),
          total: last.data.total,
          limited: last.data.limited,
        };
      };

      assertEquals(await run(2), {
        names: ["a", "b"],
        total: 2,
        limited: true,
      });
      assertEquals(await run(3), {
        names: ["a", "b"],
        total: 2,
        limited: false,
      });
    } finally {
      ctx.repoContext.catalogStore.close();
    }
  });
});
