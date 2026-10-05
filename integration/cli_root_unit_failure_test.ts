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

// Failure path of a CLI command's root unit (swamp-club#3033) that the
// characterization rows cannot reach: `access grant create` without a model
// lock marks the whole cache and pushes it. Before the root unit a failed
// mark only warned and skipped the push; it still does.

import "../src/domain/models/models.ts";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import { VERSION } from "../src/cli/commands/version.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import { runCli, UNSET_ENV } from "./usecase_sync_fixtures.ts";

await initializeLogging({});

Deno.test("access grant create: a failed bare mark warns, skips the push, and the command still succeeds", async () => {
  const remote = createInMemoryRemote();
  const bareMarks: string[] = [];
  const type = registerTestDatastoreType({
    connect: (cache) => {
      const service = remote.connect(cache, { instance: "A" });
      return {
        ...service,
        markDirty: (options) => {
          if (options === undefined) {
            bareMarks.push("bare");
            return Promise.reject(new Error("cache unwritable"));
          }
          return service.markDirty(options);
        },
      };
    },
  });
  const dir = await Deno.makeTempDir({ prefix: "swamp-root-unit-failure-" });
  try {
    const homeDir = join(dir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    await configureTestDatastore(dir, type.typeName);

    await withMockedEnv(UNSET_ENV, () =>
      runCli({
        args: [
          "access",
          "grant",
          "create",
          "--subject",
          "user:adam",
          "--allow",
          "run",
          "--on",
          "workflow:*",
          "--repo-dir",
          dir,
          "--json",
        ],
      }));

    assertEquals(bareMarks, ["bare"], "the command made its bare mark");
    assertEquals(
      remote.ops().filter((op) => op.op === "push"),
      [],
      "a failed mark skips the push",
    );
  } finally {
    await flushDatastoreSync();
    type.dispose();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
