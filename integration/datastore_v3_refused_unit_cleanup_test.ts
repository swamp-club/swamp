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
 * Work a v3 command drops never stays in its checkout (swamp-club#3553): a
 * refused commit, an abandoned root or a use case that threw leaves the
 * files its repositories wrote. The command recovers its checkout before it
 * exits when it still holds the writer lease; one that lost it keeps its
 * writer marker, and the next command in the checkout recovers.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { WriterFencedError } from "../src/domain/datastore_v3/writer_lease.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import {
  closeV3Datastores,
  v3RepositoryFactoryConfig,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  readWriterMarker,
  writerMarkerPath,
} from "../src/infrastructure/datastore_v3/interrupted_writer_recovery.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import { saveData, saveModel } from "./serve_request_harness.ts";
import type { RowRepos } from "./usecase_sync_fixtures.ts";
import {
  assertCheckoutsAgree,
  datastoreRecords,
  withV3RowRepos,
} from "./usecase_v3_fixtures.ts";

await initializeLogging({});

/** A pid no process has, for a marker whose writer is gone. */
const GONE_PID = 99_999_999;

function filesystemConfig(repos: RowRepos) {
  const config = repos.a.datastoreConfig;
  if (isCustomDatastoreConfig(config) || config.type !== "filesystem") {
    throw new Error("a v3 row runs on a filesystem datastore");
  }
  return config;
}

function inRoot<T>(repos: RowRepos, fn: () => Promise<T>): Promise<T> {
  return runInRootUnitOfWork(repos.a.repoContext, { flush: undefined }, fn);
}

/** The versions of `name` A's checkout holds, from its version directories. */
async function localVersions(repos: RowRepos, name: string): Promise<number[]> {
  const versions = new Set<number>();
  for (const key of (await datastoreRecords(repos.repoA)).keys()) {
    const parts = key.split("/");
    const at = parts.indexOf(name);
    if (at > 0 && parts[0] === "data" && /^\d+$/.test(parts[at + 1] ?? "")) {
      versions.add(Number(parts[at + 1]));
    }
  }
  return [...versions].sort((x, y) => x - y);
}

/** The data name's latest marker in A's checkout, or undefined. */
async function latestMarker(
  repos: RowRepos,
  name: string,
): Promise<string | undefined> {
  const key = [...(await datastoreRecords(repos.repoA)).keys()].find((k) =>
    k.split("/").includes(name) && k.endsWith("/latest")
  );
  return key === undefined ? undefined : (await Deno.readTextFile(
    join(swampPath(repos.repoA), ...key.split("/")),
  )).trim();
}

/** Every file A's checkout holds under `name`, as record keys. */
async function recordsOf(repos: RowRepos, name: string): Promise<string[]> {
  return [...(await datastoreRecords(repos.repoA)).keys()].filter((key) =>
    key.split("/").includes(name)
  );
}

/** The fenced refusal `error` is, or carries as its cause. */
function fencedRefusal(error: unknown): WriterFencedError | undefined {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (e instanceof WriterFencedError) return e;
  }
  return undefined;
}

/** A model with one committed version of `name`, saved through A. */
async function committedModel(
  repos: RowRepos,
  name: string,
): Promise<Definition> {
  const model = await inRoot(repos, () => saveModel(repos.serveRepo, "m1"));
  await inRoot(repos, () => saveData(repos.serveRepo, model, name));
  return model;
}

/**
 * Sets every file of A's checkout back an hour, so a recovery's replay,
 * which rewrites every committed file, shows in their mtimes.
 */
async function ageCheckout(repos: RowRepos): Promise<Map<string, number>> {
  const old = new Date(Date.now() - 3_600_000);
  const mtimes = new Map<string, number>();
  for (const key of (await datastoreRecords(repos.repoA)).keys()) {
    const path = join(swampPath(repos.repoA), ...key.split("/"));
    await Deno.utime(path, old, old);
    mtimes.set(key, (await Deno.stat(path)).mtime!.getTime());
  }
  return mtimes;
}

async function assertNotReplayed(
  repos: RowRepos,
  before: Map<string, number>,
): Promise<void> {
  for (const [key, mtime] of before) {
    const path = join(swampPath(repos.repoA), ...key.split("/"));
    assertEquals(
      (await Deno.stat(path)).mtime!.getTime(),
      mtime,
      `${key} was rewritten: a recovery ran`,
    );
  }
}

Deno.test("v3 dropped work: a writer refused after another process took its lease keeps its marker, and the next command removes the refused version", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const model = await committedModel(repos, "glass");
    assertEquals(await localVersions(repos, "glass"), [1]);

    // Another process takes the lease while A is paused, as breakglass does.
    const taker = await plantV3WriterLease(datastorePath, { pid: Deno.pid });
    const store = SqliteCommitStore.open(join(datastorePath, "commits.db"));
    try {
      await store.raiseWriterFence(taker.fence);
    } finally {
      await store.close();
    }
    const error = await assertRejects(() =>
      inRoot(repos, () => saveData(repos.serveRepo, model, "glass"))
    );
    assert(fencedRefusal(error) !== undefined, `not fenced: ${error}`);
    assertEquals(await localVersions(repos, "glass"), [1, 2]);

    // A lost the lease, so it cannot recover: its marker stays.
    await closeV3Datastores();
    const marker = await readWriterMarker(repos.repoA);
    assertExists(marker, "a writer that dropped work keeps its marker");
    await taker.release();

    // The next command, once A's process is gone, recovers the checkout.
    await Deno.writeTextFile(
      writerMarkerPath(repos.repoA),
      JSON.stringify({ ...marker, pid: GONE_PID, instance: undefined }),
    );
    await v3RepositoryFactoryConfig(repos.repoA, filesystemConfig(repos), {
      readOnly: true,
    });
    await closeV3Datastores();
    assertEquals(await localVersions(repos, "glass"), [1]);
    assertEquals(await latestMarker(repos, "glass"), "1");
    assert(await assertCheckoutsAgree(repos, datastorePath, "recovered") > 0);
    await closeV3Datastores();

    // A's next write takes the number after the committed one.
    const next = await requireInitializedRepoUnlocked({
      repoDir: repos.repoA,
      outputMode: "json",
    });
    await runInRootUnitOfWork(
      next.repoContext,
      { flush: undefined },
      () =>
        saveData(
          { ...repos.serveRepo, repoContext: next.repoContext },
          model,
          "glass",
        ),
    );
    assertEquals(await localVersions(repos, "glass"), [1, 2]);
    await closeV3Datastores();
    assert(await assertCheckoutsAgree(repos, datastorePath, "next write") > 0);
  });
});

Deno.test("v3 dropped work: an abandoned root's files are removed before the command ends, and its marker goes", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const model = await committedModel(repos, "glass");
    await runInRootUnitOfWork(repos.a.repoContext, {
      flush: undefined,
      pushWhen: "completed",
    }, async () => {
      await saveData(repos.serveRepo, model, "glass");
      await saveData(repos.serveRepo, model, "dropped");
      throw new Error("the operation failed");
    }).catch(() => {});
    assertEquals(await localVersions(repos, "glass"), [1, 2]);

    await closeV3Datastores();
    assertEquals(await localVersions(repos, "glass"), [1]);
    assertEquals(await latestMarker(repos, "glass"), "1");
    assertEquals(await recordsOf(repos, "dropped"), []);
    assertEquals(await readWriterMarker(repos.repoA), undefined);
    assert(await assertCheckoutsAgree(repos, datastorePath, "abandoned") > 0);
  });
});

Deno.test("v3 dropped work: a use case that threw inside a root that commits leaves none of its files", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const model = await committedModel(repos, "glass");
    await inRoot(repos, async () => {
      await saveData(repos.serveRepo, model, "kept");
      // A use case's own unit, inside the command's root, that throws.
      await runInRootUnitOfWork(repos.a.repoContext, {
        flush: undefined,
        pushWhen: "completed",
      }, async () => {
        await saveData(repos.serveRepo, model, "glass");
        throw new Error("the use case failed");
      }).catch(() => {});
    });
    assertEquals(await localVersions(repos, "glass"), [1, 2]);

    await closeV3Datastores();
    assertEquals(await localVersions(repos, "glass"), [1]);
    assertEquals(await localVersions(repos, "kept"), [1]);
    assertEquals(await readWriterMarker(repos.repoA), undefined);
    assert(await assertCheckoutsAgree(repos, datastorePath, "use case") > 0);
  });
});

Deno.test("v3 dropped work: a command that drops nothing, or fails before it writes, runs no recovery", async () => {
  await withV3RowRepos({}, async (repos) => {
    const model = await committedModel(repos, "glass");
    const aged = await ageCheckout(repos);
    await inRoot(repos, () => saveData(repos.serveRepo, model, "other"));
    await runInRootUnitOfWork(repos.a.repoContext, {
      flush: undefined,
      pushWhen: "completed",
    }, () => Promise.reject(new Error("refused before any write")))
      .catch(() => {});
    await closeV3Datastores();
    await assertNotReplayed(repos, aged);
    assertEquals(await readWriterMarker(repos.repoA), undefined);
  });
});

Deno.test("v3 dropped work: a teardown with a unit still open keeps the marker, so the next command recovers", async () => {
  await withV3RowRepos({}, async (repos) => {
    const model = await committedModel(repos, "glass");
    const release = Promise.withResolvers<void>();
    const open = inRoot(repos, () => release.promise).catch(() => {});
    await runInRootUnitOfWork(repos.a.repoContext, {
      flush: undefined,
      pushWhen: "completed",
    }, async () => {
      await saveData(repos.serveRepo, model, "glass");
      throw new Error("the operation failed");
    }).catch(() => {});

    await closeV3Datastores();
    assertExists(
      await readWriterMarker(repos.repoA),
      "a unit was still open: the next command recovers",
    );
    assertEquals(await localVersions(repos, "glass"), [1, 2]);
    release.resolve();
    await open;
  });
});
