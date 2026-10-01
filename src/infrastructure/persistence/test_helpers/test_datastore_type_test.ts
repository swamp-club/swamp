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

import "../../../domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import { requireInitializedRepo } from "../../../cli/repo_context.ts";
import { VERSION } from "../../../cli/commands/version.ts";
import { Data } from "../../../domain/data/data.ts";
import { datastoreTypeRegistry } from "../../../domain/datastore/datastore_type_registry.ts";
import { ModelType } from "../../../domain/models/model_type.ts";
import { RepoPath } from "../../../domain/repo/repo_path.ts";
import { RepoService } from "../../../domain/repo/repo_service.ts";
import { initializeLogging } from "../../logging/logger.ts";
import { assertPathEquals } from "../path_test_helpers.ts";
import { registerTestDatastoreType } from "./test_datastore_type.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-datastore-" });
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

async function initializeRepo(dir: string): Promise<void> {
  const homeDir = join(dir, "test-home");
  const service = new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  });
  await service.init(RepoPath.create(dir), { tools: [] });
}

Deno.test("registerTestDatastoreType: requireInitializedRepo connects the repo cache to the remote", async () => {
  const remote = createInMemoryRemote();
  const testType = registerTestDatastoreType(remote);
  try {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "machine-a");
      await Deno.mkdir(repoDir);
      await initializeRepo(repoDir);
      await testType.configureRepo(repoDir);

      const repo = await requireInitializedRepo({
        repoDir,
        outputMode: "json",
        skipImplicitSync: true,
      });

      const [connection] = testType.connections();
      assert(connection, "expected the provider to connect a sync service");
      assertEquals(connection.instance, "machine-a");
      assertPathEquals(connection.cacheDir, join(repoDir, ".test-cache"));

      const before = connection.marks().length;
      await repo.repoContext.unifiedDataRepo.save(
        ModelType.create("test/remote"),
        "model-x",
        Data.create({
          name: "probe",
          contentType: "text/plain",
          lifetime: "infinite",
          garbageCollection: 100,
          tags: { type: "test" },
          ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
        }),
        new TextEncoder().encode("payload"),
      );
      // The save marks the data-name directory; the push expands it.
      assertEquals(connection.marks().slice(before), [
        "data/test/remote/model-x/probe",
      ]);

      assertEquals(await connection.pushChanged(), 3);
      assertEquals([...remote.files().keys()].sort(), [
        "data/test/remote/model-x/probe/1/metadata.yaml",
        "data/test/remote/model-x/probe/1/raw",
        "data/test/remote/model-x/probe/latest",
      ]);
      repo.repoContext.catalogStore.close();
    });
  } finally {
    testType.dispose();
  }
});

Deno.test("registerTestDatastoreType: dispose unregisters the type", () => {
  const testType = registerTestDatastoreType(createInMemoryRemote());
  try {
    assert(datastoreTypeRegistry.has(testType.typeName));
  } finally {
    testType.dispose();
  }
  assertEquals(datastoreTypeRegistry.has(testType.typeName), false);
});
