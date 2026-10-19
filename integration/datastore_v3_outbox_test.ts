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
 * The commit outbox on a v3 filesystem datastore (swamp-club#3490): a writer
 * killed while it commits leaves its commit for the next writer to land
 * once, unless another writer came in between or the partition moved on,
 * and no stored commit is left naming a chunk a sweep deleted.
 *
 * The killed writer runs in a Worker (`datastore_v3_outbox_crash_worker.ts`)
 * that stops at a named point and is terminated there. It names a gone pid
 * and holds a lease planted under it, as a killed process leaves them.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { DatabaseSync } from "node:sqlite";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import type { CommitLogUnitOfWork } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { createCommitLogUnitOfWork } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { SqliteCommitOutbox } from "../src/infrastructure/datastore_v3/sqlite_commit_outbox.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import {
  openV3Datastore,
  v3OutboxPath,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  acquireV3WriterLock,
  tryAcquireV3WriterLock,
  v3WriterFence,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import { writerMarkerPath } from "../src/infrastructure/datastore_v3/interrupted_writer_recovery.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import type { RowRepos } from "./usecase_sync_fixtures.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";
import type {
  OutboxCrashMessage,
  OutboxCrashPause,
  OutboxCrashRequest,
} from "./datastore_v3_outbox_crash_worker.ts";

await initializeLogging({});

/** A pid no process has: above every platform's pid limit. */
const GONE_PID = 99_999_999;

/** Past the inline limit, so the content is stored as chunks. */
const CHUNKED = 200 * 1024;

const signal = new AbortController().signal;

interface KilledWriter {
  readonly id: string;
  readonly fence: number;
  readonly checkoutFile: string;
}

/**
 * Runs a writer in a Worker that commits one auto-definition in A's
 * checkout and is terminated at `killAt`. At each other pause `onPause`
 * runs, then the writer goes on. It holds a lease planted under a gone pid,
 * and leaves A's writer marker naming it, as a killed process does.
 */
async function killWriter(
  repos: RowRepos,
  datastorePath: string,
  options: {
    readonly pauses: readonly OutboxCrashPause[];
    readonly killAt: OutboxCrashPause;
    readonly bytes?: number;
    readonly onPause?: (point: OutboxCrashPause) => Promise<void>;
  },
): Promise<KilledWriter> {
  await closeV3Datastores();
  const since = Math.floor(Date.now() / 1000) * 1000 - 2_000;
  const lease = await plantV3WriterLease(datastorePath, { pid: GONE_PID });
  // As the dead writer's lease take did: the store's fence and the outbox's
  // chain.
  const handle = openV3Datastore({ repoDir: repos.repoA, datastorePath });
  await handle.raiseWriterFence(lease.fence);
  const commitsDb = handle.commitsDbPath;
  await handle.close();
  await Deno.writeTextFile(
    writerMarkerPath(repos.repoA),
    JSON.stringify({ hostname: Deno.hostname(), pid: GONE_PID, since }),
  );
  const id = crypto.randomUUID();
  const checkoutFile = join(
    swampPath(repos.repoA),
    "auto-definitions",
    `${id}.yaml`,
  );
  const worker = new Worker(
    new URL("./datastore_v3_outbox_crash_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  let killed = false;
  let failed: string | undefined;
  let done = false;
  try {
    worker.onmessage = async (event: MessageEvent<OutboxCrashMessage>) => {
      const message = event.data;
      if ("failed" in message) failed = message.failed;
      else if ("done" in message) done = true;
      else if (message.paused === options.killAt) {
        worker.terminate();
        killed = true;
      } else {
        await options.onPause?.(message.paused);
        worker.postMessage("resume");
      }
    };
    worker.postMessage(
      {
        datastorePath,
        checkoutFile,
        commitsDb,
        outboxPath: v3OutboxPath(commitsDb),
        fence: lease.fence,
        writerPid: GONE_PID,
        id,
        bytes: options.bytes ?? 64,
        pauses: options.pauses,
      } satisfies OutboxCrashRequest,
    );
    await waitFor(
      () => killed || failed !== undefined || done,
      "the writer to reach its kill point",
    );
  } finally {
    worker.terminate();
  }
  assertEquals(failed, undefined, "the writer failed");
  assert(killed, "the writer committed without being killed");
  return { id, fence: lease.fence, checkoutFile };
}

/** A writing command's start in A: its lease, recoveries and marker. */
async function startWriter(repos: RowRepos): Promise<void> {
  await requireInitializedRepoUnlocked({
    repoDir: repos.repoA,
    outputMode: "json",
  });
  await closeV3Datastores();
}

/** The commits of an auto-definition's partition. */
async function commitsOf(datastorePath: string, id: string): Promise<Commit[]> {
  const store = SqliteCommitStore.open(join(datastorePath, "commits.db"));
  try {
    return (await store.readPartition(
      "",
      partitionOf({ kind: "definition", id }),
      1,
      100,
    )).map((change) => change.commit);
  } finally {
    await store.close();
  }
}

async function outboxHasEntries(datastorePath: string): Promise<boolean> {
  const outbox = new SqliteCommitOutbox(
    v3OutboxPath(join(datastorePath, "commits.db")),
  );
  try {
    return await outbox.hasEntries();
  } finally {
    await outbox.close();
  }
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

/** Dates every stored chunk past the collector's grace period. */
async function ageChunks(datastorePath: string): Promise<number> {
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  let aged = 0;
  for await (
    const entry of walk(join(datastorePath, "_blobs"), { includeDirs: false })
  ) {
    await Deno.utime(entry.path, old, old);
    aged++;
  }
  return aged;
}

/** A sweep of the datastore's chunks, as `swamp datastore gc` runs one. */
async function sweep(repos: RowRepos, datastorePath: string) {
  const handle = openV3Datastore({ repoDir: repos.repoB, datastorePath });
  try {
    return await handle.collectChunks(signal);
  } finally {
    await handle.close();
  }
}

/** The chunks the partition's stored commits name that are missing. */
async function missingChunks(
  datastorePath: string,
  commits: readonly Commit[],
): Promise<string[]> {
  const chunkStore = new ChunkStore(new FileSystemStorage(datastorePath));
  const missing: string[] = [];
  for (const commit of commits) {
    for (const op of commit.ops) {
      if (op.kind === "put" && "blob" in op.content) {
        missing.push(
          ...await chunkStore.missing(SOLO_NAMESPACE, op.content.blob, signal),
        );
      }
    }
  }
  return missing;
}

Deno.test("v3 outbox: a writer killed before its append lands is landed once by the next writer, which keeps its file", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const killed = await killWriter(repos, datastorePath, {
      pauses: ["after-prepare"],
      killAt: "after-prepare",
    });
    assertEquals(await commitsOf(datastorePath, killed.id), []);
    await startWriter(repos);
    const commits = await commitsOf(datastorePath, killed.id);
    assertEquals(commits.length, 1);
    assert(commits[0].fence! > killed.fence, "under the recovering lease");
    assertEquals(await outboxHasEntries(datastorePath), false);
    assert(
      await exists(killed.checkoutFile),
      "the interrupted-writer recovery keeps a file a commit owns",
    );
    // A later writer lands nothing more.
    await startWriter(repos);
    assertEquals((await commitsOf(datastorePath, killed.id)).length, 1);
  });
});

Deno.test("v3 outbox: a writer killed after its append lands settles as a duplicate", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const killed = await killWriter(repos, datastorePath, {
      pauses: ["after-append"],
      killAt: "after-append",
    });
    assertEquals((await commitsOf(datastorePath, killed.id)).length, 1);
    assertEquals(await outboxHasEntries(datastorePath), true);
    await startWriter(repos);
    const commits = await commitsOf(datastorePath, killed.id);
    assertEquals(commits.length, 1);
    assertEquals(commits[0].fence, killed.fence, "the dead writer's commit");
    assertEquals(await outboxHasEntries(datastorePath), false);
  });
});

Deno.test("v3 outbox: a fence another writer took and gave up without writing does not drop a killed writer's commit in shared mode (swamp-club#3586)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const killed = await killWriter(repos, datastorePath, {
      pauses: ["after-prepare"],
      killAt: "after-prepare",
    });
    // A writer takes the next fence and dies before raising it: the chain
    // never records that fence. Shared mode has one copy, and every writer
    // recovers before it writes, so the gap is no other copy's.
    const other = await plantV3WriterLease(datastorePath, { pid: GONE_PID });
    await other.release();
    await startWriter(repos);
    assertEquals((await commitsOf(datastorePath, killed.id)).length, 1);
    assertEquals(await outboxHasEntries(datastorePath), false);
    assertEquals(await exists(killed.checkoutFile), true);
  });
});

Deno.test("v3 outbox: a writer start whose outbox record or store raise fails does not drop a killed writer's commit (swamp-club#3586)", async () => {
  for (const failing of ["record", "raise"] as const) {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      const killed = await killWriter(repos, datastorePath, {
        pauses: ["after-prepare"],
        killAt: "after-prepare",
      });
      // The next writer takes a fence, and its start fails between the
      // store's raise and the outbox's record, or on the raise itself.
      const next = await plantV3WriterLease(datastorePath, { pid: GONE_PID });
      const handle = openV3Datastore({ repoDir: repos.repoA, datastorePath });
      try {
        const target = failing === "record"
          ? handle.outbox
          : handle.commitStore;
        Object.defineProperty(
          target,
          failing === "record" ? "recordFence" : "raiseWriterFence",
          {
            configurable: true,
            value: () => Promise.reject(new Error("database or disk is full")),
          },
        );
        await assertRejects(
          () => handle.raiseWriterFence(next.fence),
          Error,
          "disk is full",
        );
      } finally {
        await handle.close();
      }
      await next.release();
      await startWriter(repos);
      assertEquals(
        (await commitsOf(datastorePath, killed.id)).length,
        1,
        failing,
      );
      assertEquals(await outboxHasEntries(datastorePath), false);
    });
  }
});

Deno.test("v3 outbox: an entry whose partition was committed since is dropped, never landed over it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const killed = await killWriter(repos, datastorePath, {
      pauses: ["after-prepare"],
      killAt: "after-prepare",
    });
    // A commit to the same partition, under the same lease, lands first.
    const store = SqliteCommitStore.open(join(datastorePath, "commits.db"));
    try {
      const unit = createCommitLogUnitOfWork(() => Promise.resolve(), {
        sink: store,
        chunkStore: new ChunkStore(new FileSystemStorage(datastorePath)),
        namespace: SOLO_NAMESPACE,
        writer: { host: Deno.hostname(), pid: GONE_PID, instance: "newer" },
        fence: killed.fence,
        signal,
      });
      await unit.stageOps([
        new AutoDefinitionChanges(killed.id).write(
          recordKeyOf(["auto-definitions", `${killed.id}.yaml`]),
          new TextEncoder().encode("newer"),
        ),
      ]);
      await unit.commit();
    } finally {
      await store.close();
    }
    await startWriter(repos);
    const commits = await commitsOf(datastorePath, killed.id);
    assertEquals(commits.map((commit) => commit.writer.instance), ["newer"]);
    assertEquals(await outboxHasEntries(datastorePath), false);
  });
});

Deno.test("v3 outbox: a sweep while a killed writer's commit was prepared keeps its chunks", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    let swept: Awaited<ReturnType<typeof sweep>> | undefined;
    const killed = await killWriter(repos, datastorePath, {
      bytes: CHUNKED,
      pauses: ["after-prepare", "after-append"],
      killAt: "after-append",
      // The sweep sees the chunks old and unreferenced by any commit.
      onPause: async () => {
        assert(await ageChunks(datastorePath) > 0);
        swept = await sweep(repos, datastorePath);
      },
    });
    assertEquals(swept?.deleted, 0, "the outbox entry names them");
    await startWriter(repos);
    const commits = await commitsOf(datastorePath, killed.id);
    assertEquals(commits.length, 1);
    assertEquals(await missingChunks(datastorePath, commits), []);
  });
});

Deno.test("v3 outbox: a sweep that deleted a writer's chunks before it prepared is caught before the append", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    let swept: Awaited<ReturnType<typeof sweep>> | undefined;
    const killed = await killWriter(repos, datastorePath, {
      bytes: CHUNKED,
      pauses: ["before-prepare", "after-append"],
      killAt: "after-append",
      // Stored, then deleted by a sweep that ends before the prepare.
      onPause: async () => {
        assert(await ageChunks(datastorePath) > 0);
        swept = await sweep(repos, datastorePath);
      },
    });
    assert((swept?.deleted ?? 0) > 0, "the sweep deleted the chunks");
    await startWriter(repos);
    const commits = await commitsOf(datastorePath, killed.id);
    assertEquals(commits.length, 1);
    assertEquals(await missingChunks(datastorePath, commits), []);
  });
});

Deno.test("v3 outbox: a production handle's units prepare each commit", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    const handle: ReturnType<typeof openV3Datastore> = openV3Datastore({
      repoDir: repos.repoA,
      datastorePath,
      writerFence: () => handle.writerFence(),
    });
    // Every append fails after its preparation.
    const db = new DatabaseSync(handle.commitsDbPath);
    db.exec(`
      CREATE TRIGGER fail_append BEFORE INSERT ON commits
      BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    try {
      const engine = handle.engineFor(() => Promise.resolve(), () => {
        throw new Error("no run repository needed");
      });
      // A root unit: its checkpoint commits.
      const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
      await unit.stageOps([
        new AutoDefinitionChanges(crypto.randomUUID()).write(
          recordKeyOf(["auto-definitions", "x.yaml"]),
          new TextEncoder().encode("x"),
        ),
      ]);
      const failure = await unit.checkpoint().then(() => undefined, (e) => e);
      assert(String(failure).includes("disk full"), String(failure));
      const preparedWhileOpen = await handle.outbox.hasEntries();
      await unit.abandon();
      assertEquals(preparedWhileOpen, true);
      assertEquals(await handle.outbox.hasEntries(), false);
    } finally {
      db.exec("DROP TRIGGER fail_append");
      db.close();
      await handle.close();
    }
  });
});

Deno.test("v3 outbox: every lease taken on the copy is in its fence chain", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const config = repos.a.datastoreConfig as FilesystemDatastoreConfig;
    const chain = async () => {
      const outbox = new SqliteCommitOutbox(
        v3OutboxPath(join(datastorePath, "commits.db")),
      );
      try {
        return await outbox.chain();
      } finally {
        await outbox.close();
      }
    };
    // A writing command's first take.
    const first = v3WriterFence(datastorePath)!;
    assertEquals((await chain())?.lastFence, first);
    await closeV3Datastores();

    // A read-only command's recovery hold.
    const handle = openV3Datastore({ repoDir: repos.repoB, datastorePath });
    const release = await tryAcquireV3WriterLock(datastorePath, {
      fenceStore: handle,
    });
    assert(release !== undefined);
    await release();
    await handle.close();
    assertEquals(await chain(), {
      lastFence: first + 1,
      chainStart: (await chain())!.chainStart,
      floor: (await chain())!.floor,
    });

    // Serve's retake of a lost hold.
    const own = await acquireV3WriterLock(datastorePath, {
      ttlMs: 900,
      retakeLost: true,
      fenceStore: v3DatastoreFor(repos.repoA, config),
    });
    try {
      await holdV3Writer(config, repos.repoA, { retakeLost: true });
      const held = v3WriterFence(datastorePath)!;
      const other = await plantV3WriterLease(datastorePath, {
        pid: Deno.ppid,
      });
      await waitFor(
        () =>
          v3WriterFence(datastorePath) === undefined ||
          v3WriterFence(datastorePath)! < other.fence,
        "serve to notice it lost the lease",
      );
      await other.release();
      await waitFor(
        () => (v3WriterFence(datastorePath) ?? 0) > other.fence,
        "serve to take the lease again",
      );
      const retaken = v3WriterFence(datastorePath)!;
      assert(retaken > held);
      await waitFor(
        async () => (await chain())?.lastFence === retaken,
        "the retake's fence to reach the chain",
      );
    } finally {
      await own();
    }
  });
});

Deno.test("v3 outbox: serve's retake lands what a writer between its two holds left", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const config = repos.a.datastoreConfig as FilesystemDatastoreConfig;
    await closeV3Datastores();
    const own = await acquireV3WriterLock(datastorePath, {
      ttlMs: 900,
      retakeLost: true,
      fenceStore: v3DatastoreFor(repos.repoA, config),
    });
    try {
      await holdV3Writer(config, repos.repoA, { retakeLost: true });
      // Another writer on the same commits.db takes the next fence, prepares
      // a commit and dies: its fence is in the shared chain.
      const between = await plantV3WriterLease(datastorePath, {
        pid: GONE_PID,
      });
      const other = openV3Datastore({ repoDir: repos.repoB, datastorePath });
      await other.raiseWriterFence(between.fence);
      const id = crypto.randomUUID();
      const content = new TextEncoder().encode("between");
      const unit = createCommitLogUnitOfWork(() => Promise.resolve(), {
        sink: {
          head: (ns, p) => other.commitStore.head(ns, p),
          // Dies before its append lands.
          append: () => Promise.reject(new Error("killed")),
          outbox: {
            headIdentity: (ns, p) => other.commitStore.headIdentity(ns, p),
            prepare: (preparation) => other.outbox.prepare(preparation),
            settle: () => Promise.resolve(),
            discard: () => Promise.resolve(),
            sweepState: () => other.outbox.sweepState(Date.now()),
          },
        },
        chunkStore: other.chunkStore,
        namespace: SOLO_NAMESPACE,
        writer: { host: Deno.hostname(), pid: GONE_PID, instance: "between" },
        fence: between.fence,
        signal,
      });
      await unit.stageOps([
        new AutoDefinitionChanges(id).write(
          recordKeyOf(["auto-definitions", `${id}.yaml`]),
          content,
        ),
      ]);
      await unit.checkpoint().catch(() => {});
      await other.close();
      await waitFor(
        async () => (await commitsOf(datastorePath, id)).length === 1,
        "serve's retake to land the commit",
      );
      assertEquals(await outboxHasEntries(datastorePath), false);
    } finally {
      await own();
    }
  });
});
