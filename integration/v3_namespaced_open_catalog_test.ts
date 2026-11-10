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

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { requireInitializedRepo } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { v3CatalogPath } from "../src/infrastructure/datastore_v3/record_path_guard.ts";

await initializeLogging({});

function catalogGeneration(repoDir: string): number {
  const store = new CatalogStore(v3CatalogPath(repoDir));
  try {
    return store.generation();
  } finally {
    store.close();
  }
}

async function openWithGlobalLock(repoDir: string): Promise<void> {
  await requireInitializedRepo({ repoDir, outputMode: "json" });
  await flushDatastoreSync();
  await closeV3Datastores();
}

Deno.test("requireInitializedRepo: opening a namespaced filesystem v3 datastore leaves the read model's catalog alone (swamp-club#4387)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-ns-open-" });
  try {
    const repoDir = join(dir, "repo");
    const datastore = join(dir, "v3-store");
    await Deno.mkdir(repoDir, { recursive: true });
    const homeDir = join(repoDir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });
    await initializeV3Datastore(datastore, "test");
    const marker = join(repoDir, ".swamp.yaml");
    await Deno.writeTextFile(
      marker,
      (await Deno.readTextFile(marker)).trimEnd() + "\n" + [
        "datastore:",
        "  type: filesystem",
        `  path: '${datastore}'`,
        "  format: 3",
        "  namespace: team",
      ].join("\n") + "\n",
    );

    await openWithGlobalLock(repoDir);
    const first = catalogGeneration(repoDir);
    await openWithGlobalLock(repoDir);
    await openWithGlobalLock(repoDir);
    assertEquals(catalogGeneration(repoDir), first);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
