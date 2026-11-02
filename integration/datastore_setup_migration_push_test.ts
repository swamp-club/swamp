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
import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { registerTestDatastoreType } from "../src/infrastructure/testing/test_datastore_type.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createDatastoreSetupDeps,
  type DatastoreSetupEvent,
  datastoreSetupExtension,
} from "../src/libswamp/datastores/setup.ts";
import { collect } from "../src/libswamp/testing.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

const NS = "infra";
const TEAMMATE_KEY = `${NS}/data/teammate/t.json`;
const MIGRATED_KEYS = [
  `${NS}/data/mine/a.json`,
  `${NS}/workflow-runs/wf/run.yaml`,
];

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-setup-push-" });
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

async function writeFile(path: string, content: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function arrange(
  dir: string,
  remote: ReturnType<typeof createInMemoryRemote>,
  hydrated: boolean,
): Promise<{ repoDir: string; cachePath: string }> {
  const repoDir = join(dir, "repo");
  const homeDir = join(dir, "home");
  await Deno.mkdir(repoDir, { recursive: true });
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });

  const teammateCache = join(dir, "teammate-cache");
  await writeFile(join(teammateCache, TEAMMATE_KEY), '{"t":1}');
  await remote.connect(teammateCache, { instance: "teammate" })
    .pushChanged({ namespace: NS });

  // registerTestDatastoreType resolves the cache to <repoDir>/.test-cache.
  const cachePath = join(repoDir, ".test-cache");
  if (hydrated) {
    await remote.connect(cachePath, { instance: "earlier-setup" })
      .pullChanged({ namespace: NS });
  }

  await writeFile(join(repoDir, ".swamp", "data", "mine", "a.json"), '{"a":1}');
  await writeFile(
    join(repoDir, ".swamp", "workflow-runs", "wf", "run.yaml"),
    "id: r1\n",
  );
  return { repoDir, cachePath };
}

async function runSetup(
  repoDir: string,
  typeName: string,
): Promise<Extract<DatastoreSetupEvent, { kind: "completed" }>> {
  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(
      createLibSwampContext(),
      createDatastoreSetupDeps(repoDir, () => Promise.resolve(undefined)),
      {
        type: typeName,
        config: { bucket: "test-bucket" },
        repoDir,
        repoId: "repo-4100",
        skipMigration: false,
        namespace: NS,
      },
    ),
  );
  const completed = events[events.length - 1];
  assert(completed.kind === "completed", JSON.stringify(completed));
  return completed;
}

for (const hydrated of [true, false]) {
  const cache = hydrated ? "a cache an earlier pull left clean" : "a new cache";
  Deno.test(`datastoreSetupExtension: migration into ${cache} pushes the migrated files (swamp-club#4100)`, async () => {
    await withTempDir(async (dir) => {
      const remote = createInMemoryRemote();
      const { typeName, dispose } = registerTestDatastoreType(remote);
      try {
        const { repoDir } = await arrange(dir, remote, hydrated);

        const completed = await runSetup(repoDir, typeName);

        assertEquals(completed.data.errors, []);
        assertEquals(completed.data.filesCopied, 2);
        assertEquals(
          [...remote.files().keys()].sort(),
          [TEAMMATE_KEY, ...MIGRATED_KEYS].sort(),
        );
        // The source is removed only once its data reached the remote.
        assertEquals(await exists(join(repoDir, ".swamp", "data")), false);
        assertEquals(
          await exists(join(repoDir, ".swamp", "workflow-runs")),
          false,
        );
      } finally {
        dispose();
      }
    });
  });
}
