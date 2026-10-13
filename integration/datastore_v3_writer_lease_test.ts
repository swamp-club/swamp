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
 * The fenced writer lease of a filesystem v3 datastore, wired through the
 * repository contexts the CLI and serve open (swamp-club#3359): a writer
 * that lost its lease commits nothing more, a Phase 3 datastore upgrades in
 * place, and the renewal timer keeps the lease and notices losing it.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { WriterFencedError } from "../src/domain/datastore_v3/writer_lease.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import type { CommitLogUnitOfWork } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { openV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  acquireV3WriterLock,
  assertV3WriterCurrent,
  checkV3WriterLease,
  v3WriterFence,
  v3WriterLockHandle,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { saveData, saveModel } from "./serve_request_harness.ts";
import type { RowRepos } from "./usecase_sync_fixtures.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

/** Every commit `commits.db` holds, as its fence. */
async function commitFences(
  datastorePath: string,
): Promise<(number | undefined)[]> {
  const store = SqliteCommitStore.open(join(datastorePath, "commits.db"));
  try {
    return (await store.changesSince(0, 1_000)).map((change) =>
      change.commit.fence
    );
  } finally {
    await store.close();
  }
}

/** Saves a model and one data version through checkout A, in one root. */
function saveThroughA(repos: RowRepos, name: string) {
  return runInRootUnitOfWork(
    repos.a.repoContext,
    { flush: undefined },
    async () => {
      const model = await saveModel(repos.serveRepo, `m-${name}`);
      await saveData(repos.serveRepo, model, name);
    },
  );
}

/** The fenced refusal `error` is, or carries as its cause. */
function fencedRefusal(error: unknown): WriterFencedError | undefined {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (e instanceof WriterFencedError) return e;
  }
  return undefined;
}

Deno.test("v3 writer lease: every commit names the writer's fence", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const fence = v3WriterFence(datastorePath);
    assert(fence !== undefined, "checkout A holds the writer lease");
    await saveThroughA(repos, "first");
    const fences = await commitFences(datastorePath);
    assert(fences.length > 0);
    assertEquals(new Set(fences), new Set([fence]));
  });
});

Deno.test("v3 writer lease: a writer whose lease another process took over commits nothing more", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await saveThroughA(repos, "before");
    const before = await commitFences(datastorePath);

    // A was paused past its expiry: another process took the next fence
    // and recorded it in commits.db, as taking the lease does.
    const taker = await plantV3WriterLease(datastorePath, { pid: Deno.pid });
    const store = SqliteCommitStore.open(join(datastorePath, "commits.db"));
    try {
      await store.raiseWriterFence(taker.fence);
    } finally {
      await store.close();
    }

    // A wakes without knowing, and writes again: nothing lands.
    const error = await assertRejects(() => saveThroughA(repos, "after"));
    const refusal = fencedRefusal(error);
    assert(refusal !== undefined, `not a fenced refusal: ${error}`);
    assertEquals(refusal.code, "datastore_v3_writer_fenced");
    assertEquals(await commitFences(datastorePath), before);
    await taker.release();
  });
});

Deno.test("v3 writer lease: a holder whose lease was force-released stops committing before anyone takes over", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await saveThroughA(repos, "before");
    const before = await commitFences(datastorePath);
    const handle = v3WriterLockHandle(datastorePath);
    const info = await handle.inspect();
    assert(await handle.forceRelease(info!.nonce!));

    // The holder's next renewal finds its fence released.
    await assertRejects(
      () => checkV3WriterLease(datastorePath),
      WriterFencedError,
    );
    const error = await assertRejects(() => saveThroughA(repos, "after"));
    assert(fencedRefusal(error) !== undefined, `not fenced: ${error}`);
    assertEquals(await commitFences(datastorePath), before);
    assertEquals(await handle.inspect(), null, "no lock held");
  });
});

Deno.test("v3 writer lease: a Phase 3 datastore keeps its unfenced history and starts fencing at its first lease", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    // Take the datastore back to what Phase 3 left: schema 3, no lease
    // records, unfenced commits.
    await Deno.remove(join(datastorePath, "_control", "writer"), {
      recursive: true,
    });
    const db = new DatabaseSync(join(datastorePath, "commits.db"));
    db.exec("DROP TABLE writer_fence");
    db.exec("PRAGMA user_version=3");
    db.close();
    await commitUnfenced(datastorePath, join(repos.repoA, "..", "phase3"));

    const a = await requireInitializedRepoUnlocked({
      repoDir: repos.repoA,
      outputMode: "json",
    });
    const fence = v3WriterFence(datastorePath);
    assertEquals(fence, 1, "the first lease on the datastore");
    const serveRepo = { ...repos.serveRepo, repoContext: a.repoContext };
    await runInRootUnitOfWork(a.repoContext, { flush: undefined }, async () => {
      const model = await saveModel(serveRepo, "m2");
      await saveData(serveRepo, model, "fenced");
    });
    const fences = await commitFences(datastorePath);
    assert(fences.includes(undefined), "the unfenced history is kept");
    assertEquals(fences.at(-1), 1);

    // Phase 3's unfenced writes are now refused.
    await assertRejects(
      () => commitUnfenced(datastorePath, join(repos.repoA, "..", "late")),
      WriterFencedError,
    );
  });
});

/** Commits one auto-definition as a Phase 3 writer did: with no fence. */
async function commitUnfenced(
  datastorePath: string,
  repoDir: string,
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const writer = openV3Datastore({ repoDir, datastorePath });
  try {
    const engine = writer.engineFor(() => Promise.resolve(), () => {
      throw new Error("no run repository needed");
    });
    await engine.runRoot({}, async () => {
      const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
      await unit.stageOps([
        new AutoDefinitionChanges(crypto.randomUUID()).write(
          recordKeyOf(["auto-definitions", `${crypto.randomUUID()}.yaml`]),
          new TextEncoder().encode("x"),
        ),
      ]);
      await unit.commit();
    });
  } finally {
    await writer.close();
  }
}

Deno.test("v3 writer lease: the renewal timer keeps the lease, and notices another process taking it over", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-lease-renewal-" });
  try {
    const release = await acquireV3WriterLock(dir, { ttlMs: 30 });
    try {
      const heartbeat = join(
        dir,
        "_control",
        "writer",
        "heartbeat-000000000001",
      );
      await waitFor(
        () => Deno.stat(heartbeat).then(() => true, () => false),
        "the lease renewed",
      );
      assertV3WriterCurrent(dir);

      const taker = await plantV3WriterLease(dir, { pid: Deno.pid });
      await waitFor(() => {
        try {
          assertV3WriterCurrent(dir);
          return false;
        } catch {
          return true;
        }
      }, "a renewal found the higher fence");
      assertThrows(() => assertV3WriterCurrent(dir), WriterFencedError);
      await taker.release();
    } finally {
      await release();
    }
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
