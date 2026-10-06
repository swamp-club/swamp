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

// `swamp datastore config migrate` against a shared remote: the migration
// sentinel in the datastore means the migration is published, a failed push
// leaves migrate re-runnable (swamp-club#3117), and a repo whose cache
// predates another repo's migration does not migrate again (swamp-club#2621).

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { Definition } from "../src/domain/definitions/definition.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ManagedConfigUnpublishedError } from "../src/cli/managed_config_sync.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { saveModel } from "./serve_request_harness.ts";
import {
  cacheDir,
  type RowRepos,
  runCli,
  runCliRejecting,
  withRowRepos,
} from "./usecase_sync_fixtures.ts";

await initializeLogging({});

const SENTINEL = "config/managed-config-migrated.json";
const REMOTE = {
  remote: { capabilities: { twoPhaseSync: true, configRefresh: true } },
};

function migrate(repoDir: string): string[] {
  return ["datastore", "config", "migrate", "--repo-dir", repoDir, "--json"];
}

/** Parses the command's JSON output line. */
function outputOf(stdout: string[]): Record<string, unknown> {
  const line = stdout.find((l) => l.trimStart().startsWith("{"));
  assert(line !== undefined, `no JSON output in ${JSON.stringify(stdout)}`);
  return JSON.parse(line);
}

/** Saves model `name` into B's repo. */
async function saveModelInB(
  repos: RowRepos,
  name: string,
): Promise<Definition> {
  const b = await requireInitializedRepoUnlocked({
    repoDir: repos.repoB,
    outputMode: "json",
  });
  return await saveModel({
    repoDir: b.repoDir,
    repoContext: b.repoContext,
    datastoreConfig: b.datastoreConfig,
    datastoreResolver: b.datastoreResolver as Parameters<
      typeof saveModel
    >[0]["datastoreResolver"],
    modelType: repos.modelType,
  }, name);
}

/** The remote's copy of model `name`, or undefined. */
function remoteModel(repos: RowRepos, name: string): string | undefined {
  for (const [key, bytes] of repos.remote.files()) {
    if (key.startsWith("config/models/") && key.endsWith(`/${name}.yaml`)) {
      return new TextDecoder().decode(bytes);
    }
  }
  return undefined;
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

Deno.test("datastore config migrate: a re-run after a failed push publishes the migration", async () => {
  await withRowRepos(REMOTE, async (repos) => {
    const model = await saveModel(repos.serveRepo, "m1");

    repos.remote.failNext("push", new Error("datastore unreachable"));
    const error = await runCliRejecting({ args: migrate(repos.repoA) });
    assert(error instanceof ManagedConfigUnpublishedError, String(error));
    assertStringIncludes(
      error.message,
      "Run 'swamp datastore config migrate' again to publish it.",
    );
    assertEquals(
      await exists(join(cacheDir(repos.repoA), SENTINEL)),
      false,
      "no sentinel is written until the migrated files are published",
    );
    assertEquals(repos.remote.files().has(SENTINEL), false);

    // Another machine moves the remote and A then pulls unscoped, which
    // clears A's pending push under the fake's default semantics.
    const other = repos.remote.connect(cacheDir(repos.repoB), {
      instance: "B",
    });
    await Deno.mkdir(join(cacheDir(repos.repoB), "data"), { recursive: true });
    await Deno.writeTextFile(join(cacheDir(repos.repoB), "data", "x"), "x");
    await other.markDirty({ relPath: "data/x" });
    await other.pushChanged();
    await repos.remote.connect(cacheDir(repos.repoA), { instance: "A" })
      .pullChanged();

    const rerun = outputOf(await runCli({ args: migrate(repos.repoA) }));
    assertEquals(rerun.alreadyMigrated, false);
    assertEquals(repos.remote.files().has(SENTINEL), true);
    assertStringIncludes(remoteModel(repos, "m1") ?? "", model.id);
  });
});

Deno.test("datastore config migrate: a re-run publishes a sentinel whose push failed", async () => {
  await withRowRepos(REMOTE, async (repos) => {
    await saveModel(repos.serveRepo, "m1");
    await runCli({ args: migrate(repos.repoA) });
    assertEquals(repos.remote.files().has(SENTINEL), true);

    // The state a failed sentinel push leaves: the migrated files are on the
    // remote and the sentinel only in A's cache. Another machine removes the
    // remote copy.
    const otherCache = cacheDir(repos.repoB);
    const other = repos.remote.connect(otherCache, { instance: "B" });
    await other.pullChanged();
    await Deno.remove(join(otherCache, SENTINEL));
    await other.markDirty({ relPath: SENTINEL });
    await other.pushChanged();
    assertEquals(repos.remote.files().has(SENTINEL), false);

    const rerun = outputOf(await runCli({ args: migrate(repos.repoA) }));
    assertEquals(rerun.alreadyMigrated, true);
    assertEquals(repos.remote.files().has(SENTINEL), true);
  });
});

Deno.test("datastore config migrate: a repo whose cache predates another repo's migration reports already migrated", async () => {
  await withRowRepos(REMOTE, async (repos) => {
    const fromA = await saveModel(repos.serveRepo, "shared");
    const fromB = await saveModelInB(repos, "shared");
    await saveModelInB(repos, "only-b");

    await runCli({ args: migrate(repos.repoA) });
    const second = outputOf(await runCli({ args: migrate(repos.repoB) }));

    assertEquals(second, { alreadyMigrated: true, managedConfigSet: true });
    const shared = remoteModel(repos, "shared") ?? "";
    assertStringIncludes(shared, fromA.id);
    assertEquals(shared.includes(fromB.id), false);
    assertEquals(remoteModel(repos, "only-b"), undefined);
  });
});

Deno.test("datastore config migrate: a failed config pull refuses before anything is written", async () => {
  await withRowRepos(REMOTE, async (repos) => {
    await saveModel(repos.serveRepo, "m1");

    repos.remote.failNext("pull", new Error("datastore unreachable"));
    const error = await runCliRejecting({ args: migrate(repos.repoA) });
    assert(error instanceof Error);
    assertStringIncludes(
      error.message,
      "Failed to pull config from remote datastore: datastore unreachable",
    );
    const marker = await Deno.readTextFile(join(repos.repoA, ".swamp.yaml"));
    assertEquals(marker.includes("managedConfig"), false);
    assertEquals(
      await exists(join(cacheDir(repos.repoA), "config", "models")),
      false,
    );
  });
});

Deno.test("datastore config migrate: a repo that migrated after a failed push still publishes its files on re-run", async () => {
  await withRowRepos(REMOTE, async (repos) => {
    const model = await saveModel(repos.serveRepo, "m1");

    repos.remote.failNext("push", new Error("datastore unreachable"));
    await runCliRejecting({ args: migrate(repos.repoA) });

    // B finds the tier empty and publishes its own migration.
    const second = outputOf(await runCli({ args: migrate(repos.repoB) }));
    assertEquals(second.alreadyMigrated, false);

    // A's re-run adopts B's sentinel. Its pending push from the failed run
    // still publishes m1: nothing unscoped pulled into A in between, which
    // would drop that push under the fake's older-extension default
    // (@swamp/s3-datastore 2026.10.01.1 and later keep it).
    const rerun = outputOf(await runCli({ args: migrate(repos.repoA) }));
    assertEquals(rerun.alreadyMigrated, true);
    assertStringIncludes(remoteModel(repos, "m1") ?? "", model.id);
  });
});

Deno.test("datastore config migrate: reports already migrated only once the sentinel is published", async () => {
  await withRowRepos(REMOTE, async (repos) => {
    await saveModel(repos.serveRepo, "m1");
    await runCli({ args: migrate(repos.repoA) });

    repos.remote.failNext("push", new Error("datastore unreachable"));
    const stdout: string[] = [];
    const error = await runCliRejecting({ args: migrate(repos.repoA) }, stdout);

    assert(error instanceof ManagedConfigUnpublishedError, String(error));
    assertEquals(
      stdout.some((line) => line.includes("alreadyMigrated")),
      false,
      `no success output before the push failed: ${JSON.stringify(stdout)}`,
    );
  });
});
