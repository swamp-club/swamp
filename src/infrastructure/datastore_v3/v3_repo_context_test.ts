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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { createInMemoryRemote, waitFor } from "@swamp-club/swamp-testing";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { V3ChunkCollectionDeferredError } from "../../domain/datastore_v3/litestream_replication.ts";
import { UserError } from "../../domain/errors.ts";
import { swampPath } from "../persistence/paths.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
  type V3Datastore,
} from "./v3_datastore.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../../domain/datastore_v3/repository_changes.ts";
import type { CommitLogUnitOfWork } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  closeV3Datastores,
  collectChunksQuietly,
  compactQuietly,
  compactRetentionQuietly,
  holdV3Writer,
  SERVE_CHUNK_VERIFY_BYTES,
  V3_RESERVED_NAMESPACE_CODE,
  v3DatastoreFor,
  V3MaintenanceTimer,
  v3RepositoryFactoryConfig,
  v3RetentionHistory,
} from "./v3_repo_context.ts";
import { V3_CACHE_ROOT_ESCAPE_CODE } from "./cache_root_containment.ts";
import {
  acquireV3WriterLock,
  checkV3WriterLease,
  holdsV3WriterLock,
  tryAcquireV3WriterLock,
  V3_LEGACY_WRITER_LOCK_KEY,
  V3WriterBusyError,
  v3WriterFence,
  v3WriterLockHandle,
} from "./v3_writer_lock.ts";
import type { ProcessIdentity } from "../../domain/datastore_v3/process_liveness.ts";
import {
  V3_STORAGE_UNREACHABLE_CODE,
  V3StorageUnreachableError,
  WriterFencedError,
} from "../../domain/datastore_v3/writer_lease.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import type { CustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import {
  bindV3BucketDatastore,
  resetV3BucketBindingsForTesting,
} from "./v3_datastore_binding.ts";
import { writerMarkerPath } from "./interrupted_writer_recovery.ts";
import {
  localProcess,
  probeProcess,
  setLocalProcessForTesting,
} from "./process_identity.ts";
import { FileLock } from "../persistence/file_lock.ts";
import { DatabaseSync } from "node:sqlite";
import {
  plantV3WriterLease,
  thisKernelIdentity,
} from "./v3_writer_lock_test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-context-" });
  try {
    await fn(dir);
  } finally {
    await closeV3Datastores().catch(() => {});
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * A handle whose compaction is counted and can be held open. Its storage
 * moves chunks aside, as the filesystem's does, unless `storage` is given.
 */
function fakeHandle(storage: object = { quarantineChunk: () => {} }) {
  let calls = 0;
  let sweeps = 0;
  let syncs = 0;
  const verifies: unknown[][] = [];
  let release: () => void = () => {};
  const handle = {
    datastorePath: "/fake",
    storage,
    readModel: {
      syncUnsyncedFiles: () => {
        syncs++;
        return Promise.resolve(0);
      },
    },
    compactIfDue: () => {
      calls++;
      return new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
    },
    collectChunks: (_signal: AbortSignal, ...verify: unknown[]) => {
      sweeps++;
      verifies.push(verify);
      return Promise.resolve({ deleted: 0, damaged: [] });
    },
  } as unknown as V3Datastore;
  return {
    handle,
    calls: () => calls,
    sweeps: () => sweeps,
    verifies,
    syncs: () => syncs,
    finish: () => release(),
  };
}

Deno.test("V3MaintenanceTimer: runs never overlap, and stop waits for the one in flight", async () => {
  const fake = fakeHandle();
  const timer = new V3MaintenanceTimer(fake.handle, 60_000);
  timer.tick();
  timer.tick();
  timer.tick();
  assertEquals(fake.calls(), 1, "ticks during a run start nothing");
  let stopped = false;
  const stopping = timer.stop().then(() => stopped = true);
  await Promise.resolve();
  assertEquals(stopped, false, "stop waits for the compaction in flight");
  fake.finish();
  await stopping;
  assert(stopped);
  assertEquals(fake.sweeps(), 1, "a run sweeps chunks after compacting");
  assertEquals(fake.syncs(), 1, "and makes the unsynced files durable");
  timer.tick();
  assertEquals(fake.calls(), 2, "the next tick runs again");
  fake.finish();
  await timer.stop();
});

Deno.test("V3MaintenanceTimer: only serve's tick verifies chunks, 64 MiB of them; the retention pass and a quiet sweep verify none (swamp-club#3617)", async () => {
  const fake = fakeHandle();
  const timer = new V3MaintenanceTimer(fake.handle, 60_000);
  timer.tick();
  fake.finish();
  await timer.stop();
  assertEquals(SERVE_CHUNK_VERIFY_BYTES, 64 * 1024 * 1024);
  assertEquals(fake.verifies, [[{ bytes: SERVE_CHUNK_VERIFY_BYTES }]]);

  await collectChunksQuietly(fake.handle);
  const retention = {
    ...fake.handle,
    datastorePath: "/fake",
    compactBefore: () =>
      Promise.resolve({ bound: new Date(), compactedThrough: 0 }),
  } as unknown as V3Datastore;
  await compactRetentionQuietly(retention, new Date());
  assertEquals(fake.verifies.slice(1), [[], []]);
});

Deno.test("V3MaintenanceTimer: serve verifies no chunks on bucket storage, which cannot move a damaged one aside (swamp-club#3617)", async () => {
  // Bucket storage (S3, GCS) has no quarantineChunk.
  const bucket = fakeHandle({ putChunk: () => {} });
  const bucketTimer = new V3MaintenanceTimer(bucket.handle, 60_000);
  bucketTimer.tick();
  bucket.finish();
  await bucketTimer.stop();
  assertEquals(bucket.sweeps(), 1, "the tick still sweeps");
  assertEquals(bucket.verifies, [[]], "but verifies nothing");

  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const real = v3DatastoreFor(join(dir, "repo"), {
      type: "filesystem",
      path: datastorePath,
    });
    const filesystem = fakeHandle(real.storage);
    const timer = new V3MaintenanceTimer(filesystem.handle, 60_000);
    timer.tick();
    filesystem.finish();
    await timer.stop();
    assertEquals(
      filesystem.verifies,
      [[{ bytes: SERVE_CHUNK_VERIFY_BYTES }]],
      "a filesystem datastore's storage is verified",
    );
  });
});

Deno.test("V3MaintenanceTimer.runExclusive: waits for a tick in flight, and ticks during it start nothing", async () => {
  const fake = fakeHandle();
  const timer = new V3MaintenanceTimer(fake.handle, 60_000);
  timer.tick();
  const order: string[] = [];
  const exclusive = timer.runExclusive(() => {
    order.push("retention");
    return Promise.resolve(7);
  });
  await Promise.resolve();
  assertEquals(order, [], "the retention work waits for the tick");
  fake.finish();
  assertEquals(await exclusive, 7);
  assertEquals(order, ["retention"]);

  let release!: () => void;
  const held = timer.runExclusive(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  await Promise.resolve();
  timer.tick();
  assertEquals(fake.calls(), 1, "a tick during exclusive work starts nothing");
  release();
  await held;
  await timer.stop();
});

Deno.test("V3MaintenanceTimer: start is idempotent and its timer compacts", async () => {
  const fake = fakeHandle();
  const timer = new V3MaintenanceTimer(fake.handle, 1);
  timer.start();
  timer.start();
  await waitFor(() => fake.calls() === 1, "the timer's first compaction");
  fake.finish();
  await timer.stop();
});

Deno.test("V3MaintenanceTimer: start makes earlier unsynced files durable at once", async () => {
  const fake = fakeHandle();
  const timer = new V3MaintenanceTimer(fake.handle, 60_000);
  timer.start();
  await waitFor(() => fake.syncs() === 1, "the start's sync");
  assertEquals(fake.calls(), 0, "it does not compact before the interval");
  await timer.stop();
});

Deno.test("compactQuietly: a failing compaction is logged, not thrown", async () => {
  const handle = {
    datastorePath: "/fake",
    compactIfDue: () => Promise.reject(new Error("disk full")),
  } as unknown as V3Datastore;
  await compactQuietly(handle);
});

Deno.test("compactRetentionQuietly: compacts before the cutoff, then sweeps, and reports both (swamp-club#3473)", async () => {
  const calls: string[] = [];
  const cutoff = new Date("2026-10-01T00:00:00.000Z");
  const bound = new Date("2026-09-30T00:00:00.000Z");
  const handle = {
    datastorePath: "/fake",
    compactBefore: (given: Date) => {
      calls.push(`compact ${given.toISOString()}`);
      return Promise.resolve({
        bound,
        compactedThrough: 7,
        report: { point: 7, compacted: 4, batches: 1, released: 2 },
      });
    },
    collectChunks: () => {
      calls.push("collect");
      return Promise.resolve({ deleted: 2, damaged: [] });
    },
  } as unknown as V3Datastore;
  assertEquals(await compactRetentionQuietly(handle, cutoff), {
    bound,
    compactedThrough: 7,
    compacted: 4,
    chunksDeleted: 2,
  });
  assertEquals(calls, [`compact ${cutoff.toISOString()}`, "collect"]);
});

Deno.test("compactRetentionQuietly: a failing compaction is logged, not thrown, and skips the sweep", async () => {
  let collected = false;
  const handle = {
    datastorePath: "/fake",
    compactBefore: () => Promise.reject(new Error("disk full")),
    collectChunks: () => {
      collected = true;
      return Promise.resolve({ deleted: 0, damaged: [] });
    },
  } as unknown as V3Datastore;
  assertEquals(await compactRetentionQuietly(handle, new Date()), undefined);
  assertEquals(collected, false);
});

Deno.test("compactRetentionQuietly: a failing sweep still reports the compaction", async () => {
  const bound = new Date("2026-09-30T00:00:00.000Z");
  const handle = {
    datastorePath: "/fake",
    compactBefore: () =>
      Promise.resolve({ bound, compactedThrough: 0, report: undefined }),
    collectChunks: () => Promise.reject(new Error("disk gone")),
  } as unknown as V3Datastore;
  assertEquals(await compactRetentionQuietly(handle, new Date()), {
    bound,
    compactedThrough: 0,
    compacted: 0,
    chunksDeleted: 0,
  });
});

Deno.test("v3RepositoryFactoryConfig: managedConfig with the config tier left out is refused", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    await assertRejects(
      () =>
        v3RepositoryFactoryConfig(join(dir, "repo"), {
          type: "filesystem",
          path: datastorePath,
          directories: ["data"],
        }, { managedConfig: true }),
      UserError,
      "leave `config` out",
    );
  });
});

Deno.test("v3RetentionHistory: an empty history and the 7-day bound retention compacts before (swamp-club#3473)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const now = new Date("2026-10-15T00:00:00.000Z");
    const history = await v3RetentionHistory(
      join(dir, "repo"),
      { type: "filesystem", path: datastorePath },
      now,
    );
    assertEquals(history, {
      oldestCommitAt: null,
      compactionBound: new Date("2026-10-08T00:00:00.000Z"),
    });
  });
});

Deno.test("holdV3Writer: records the writer's checkout, and closeV3Datastores removes it and releases the lock", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const config = { type: "filesystem" as const, path: datastorePath };
    const repoDir = join(dir, "repo");
    await holdV3Writer(config, repoDir);
    assert(holdsV3WriterLock(datastorePath));
    const sidecar = join(datastorePath, "_control", "writer.checkout.json");
    assertEquals(JSON.parse(await Deno.readTextFile(sidecar)).pid, Deno.pid);
    v3DatastoreFor(repoDir, config);
    await closeV3Datastores();
    assertEquals(holdsV3WriterLock(datastorePath), false);
    await assertRejects(() => Deno.stat(sidecar), Deno.errors.NotFound);
  });
});

Deno.test("holdV3Writer: a hostname change while the writer runs still removes its own checkout record (swamp-club#3801)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const config = { type: "filesystem" as const, path: datastorePath };
    const repoDir = join(dir, "repo");
    await holdV3Writer(config, repoDir);
    const sidecar = join(datastorePath, "_control", "writer.checkout.json");
    // As if the machine was renamed after the record was written (a DHCP
    // renewal on macOS): the record names the old hostname. The process
    // identity it recorded is the one this process still holds.
    const record = JSON.parse(await Deno.readTextFile(sidecar));
    await Deno.writeTextFile(
      sidecar,
      JSON.stringify({ ...record, hostname: "Previous-Name.local" }),
    );
    v3DatastoreFor(repoDir, config);
    await closeV3Datastores();
    await assertRejects(() => Deno.stat(sidecar), Deno.errors.NotFound);
  });
});

Deno.test("v3RepositoryFactoryConfig: a reader in the checkout another process writes does not catch up", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir);
    // Another process on this host holds the writer lease for this checkout.
    // A live process that is not this one.
    const otherPid = Deno.ppid;
    await plantV3WriterLease(datastorePath, { pid: otherPid });
    await Deno.writeTextFile(
      join(datastorePath, "_control", "writer.checkout.json"),
      JSON.stringify({
        repoDir: await Deno.realPath(repoDir),
        hostname: Deno.hostname(),
        pid: otherPid,
      }),
    );
    // A commit exists that a catch-up would materialise.
    const key = recordKeyOf(["auto-definitions", "x.yaml"]);
    const writer = openV3Datastore({
      repoDir: join(dir, "writer"),
      datastorePath,
    });
    try {
      const hook = () => Promise.resolve();
      const engine = writer.engineFor(hook, () => {
        throw new Error("no run repository needed");
      });
      await engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(
            key,
            new TextEncoder().encode("x"),
          ),
        ]);
        await unit.commit();
      });
    } finally {
      await writer.close();
    }
    const materialised = (repo: string) =>
      Deno.stat(swampPath(repo, "auto-definitions", "x.yaml")).then(
        () => true,
        () => false,
      );

    await v3RepositoryFactoryConfig(repoDir, {
      type: "filesystem",
      path: datastorePath,
    });
    assertEquals(
      await materialised(repoDir),
      false,
      "the written checkout was not caught up",
    );

    // A checkout the other process does not write catches up as usual.
    const other = join(dir, "elsewhere");
    await v3RepositoryFactoryConfig(other, {
      type: "filesystem",
      path: datastorePath,
    });
    assertEquals(await materialised(other), true);
  });
});

Deno.test("v3RepositoryFactoryConfig: a reader catches up when the recorded writer on this host is gone, whatever its TTL (swamp-club#3299)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir);
    // A writer on this host that was killed: its lease is within its TTL.
    const otherPid = 99_999_999;
    await plantV3WriterLease(datastorePath, { pid: otherPid });
    await Deno.writeTextFile(
      join(datastorePath, "_control", "writer.checkout.json"),
      JSON.stringify({
        repoDir: await Deno.realPath(repoDir),
        hostname: Deno.hostname(),
        pid: otherPid,
      }),
    );
    // A commit exists that a catch-up would materialise.
    const key = recordKeyOf(["auto-definitions", "x.yaml"]);
    const writer = openV3Datastore({
      repoDir: join(dir, "writer"),
      datastorePath,
    });
    try {
      const hook = () => Promise.resolve();
      const engine = writer.engineFor(hook, () => {
        throw new Error("no run repository needed");
      });
      await engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(
            key,
            new TextEncoder().encode("x"),
          ),
        ]);
        await unit.commit();
      });
    } finally {
      await writer.close();
    }
    const materialised = (repo: string) =>
      Deno.stat(swampPath(repo, "auto-definitions", "x.yaml")).then(
        () => true,
        () => false,
      );

    await v3RepositoryFactoryConfig(repoDir, {
      type: "filesystem",
      path: datastorePath,
    });
    assertEquals(
      await materialised(repoDir),
      true,
      "the checkout of a gone writer catches up",
    );
  });
});

Deno.test("collectChunksQuietly: a failing sweep is logged, not thrown", async () => {
  await collectChunksQuietly({
    datastorePath: "/fake",
    collectChunks: () => Promise.reject(new Error("disk gone")),
  } as unknown as V3Datastore);
});

Deno.test("collectChunksQuietly: a deferred collection is said once at info, then at debug (swamp-club#3491)", async () => {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["datastore", "v3"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    // Unique per run, so --repeats exercises the first sweep again.
    const datastorePath = `/fake-${crypto.randomUUID()}`;
    const handle = {
      datastorePath,
      collectChunks: () =>
        Promise.reject(
          new V3ChunkCollectionDeferredError(
            datastorePath,
            "replication lineage 000000000005 may still be restored",
          ),
        ),
    } as unknown as V3Datastore;
    await collectChunksQuietly(handle);
    await collectChunksQuietly(handle);
    const levels = records.filter((record) =>
      record.message.map(String).join("").includes("000000000005")
    ).map((record) => record.level);
    assertEquals(levels, ["info", "debug"]);
  } finally {
    await reset();
  }
});

Deno.test("V3MaintenanceTimer: a real v3 datastore's chunks are swept by serve's timer", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    // An orphaned chunk, old enough to be past the grace period.
    const orphan = join(
      datastorePath,
      "_blobs",
      "_default",
      "sha256",
      "ab",
      "ab".repeat(32),
    );
    await Deno.mkdir(join(orphan, ".."), { recursive: true });
    await Deno.writeTextFile(orphan, "orphan");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await Deno.utime(orphan, old, old);
    const handle = v3DatastoreFor(join(dir, "repo"), {
      type: "filesystem",
      path: datastorePath,
    });
    const timer = new V3MaintenanceTimer(handle, 60_000);
    timer.tick();
    await timer.stop();
    await assertRejects(() => Deno.stat(orphan), Deno.errors.NotFound);
  });
});

Deno.test("v3RepositoryFactoryConfig: a reader reaching the writer's checkout through a symlink still skips catch-up", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const realRepo = join(dir, "repo");
    await Deno.mkdir(swampPath(realRepo, "_read_model_v3"), {
      recursive: true,
    });
    const linkedRepo = join(dir, "repo-link");
    await Deno.symlink(realRepo, linkedRepo, { type: "dir" });
    // A live process that is not this one.
    const otherPid = Deno.ppid;
    await plantV3WriterLease(datastorePath, { pid: otherPid });
    await Deno.writeTextFile(
      join(datastorePath, "_control", "writer.checkout.json"),
      JSON.stringify({
        repoDir: await Deno.realPath(realRepo),
        hostname: Deno.hostname(),
        pid: otherPid,
      }),
    );
    await commitOneDefinition(datastorePath, join(dir, "writer"));
    await v3RepositoryFactoryConfig(linkedRepo, {
      type: "filesystem",
      path: datastorePath,
    });
    assertEquals(
      await Deno.stat(swampPath(realRepo, "auto-definitions", "x.yaml"))
        .then(() => true, () => false),
      false,
    );
  });
});

Deno.test("holdV3Writer: a live Phase 3 writer refuses the lease before commits.db is migrated", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const db = new DatabaseSync(join(datastorePath, "commits.db"));
    db.exec("DROP TABLE writer_fence");
    db.exec("PRAGMA user_version=3");
    db.close();
    const legacy = new FileLock(datastorePath, {
      lockKey: V3_LEGACY_WRITER_LOCK_KEY,
    });
    await legacy.acquire();
    try {
      await assertRejects(
        () =>
          holdV3Writer(
            { type: "filesystem", path: datastorePath },
            join(dir, "repo"),
          ),
        V3WriterBusyError,
      );
    } finally {
      await legacy.release();
      await closeV3Datastores();
    }
    // The Phase 3 writer can still open its commits.db.
    const check = new DatabaseSync(join(datastorePath, "commits.db"));
    try {
      assertEquals(
        (check.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }).user_version,
        3,
      );
    } finally {
      check.close();
    }
  });
});

Deno.test("v3RepositoryFactoryConfig: a writing process catches up once, not again for a later context", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const config = { type: "filesystem" as const, path: datastorePath };
    const repoDir = join(dir, "repo");
    await holdV3Writer(config, repoDir);
    await v3RepositoryFactoryConfig(repoDir, config);
    // A commit lands after the first catch-up (another writer cannot exist,
    // so this stands in for this process's own commit).
    await commitOneDefinition(datastorePath, join(dir, "writer"));
    await v3RepositoryFactoryConfig(repoDir, config);
    assertEquals(
      await Deno.stat(swampPath(repoDir, "auto-definitions", "x.yaml"))
        .then(() => true, () => false),
      false,
      "the second context did not replay the commit",
    );
  });
});

/** Commits one auto-definition through a separate handle. */
async function commitOneDefinition(
  datastorePath: string,
  writerRepo: string,
): Promise<void> {
  const writer = openV3Datastore({
    repoDir: writerRepo,
    datastorePath,
    // This process's commits name its lease's fence.
    writerFence: () => v3WriterFence(datastorePath),
  });
  try {
    const engine = writer.engineFor(() => Promise.resolve(), () => {
      throw new Error("no run repository needed");
    });
    await engine.runRoot({}, async () => {
      const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
      await unit.stageOps([
        new AutoDefinitionChanges(crypto.randomUUID()).write(
          recordKeyOf(["auto-definitions", "x.yaml"]),
          new TextEncoder().encode("x"),
        ),
      ]);
      await unit.commit();
    });
  } finally {
    await writer.close();
  }
}

/** Commits one auto-definition from another checkout, for a catch-up to materialise. */
async function commitFromElsewhere(
  dir: string,
  datastorePath: string,
): Promise<void> {
  const writer = openV3Datastore({
    repoDir: join(dir, "writer"),
    datastorePath,
  });
  try {
    const engine = writer.engineFor(() => Promise.resolve(), () => {
      throw new Error("no run repository needed");
    });
    await engine.runRoot({}, async () => {
      const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
      await unit.stageOps([
        new AutoDefinitionChanges(crypto.randomUUID()).write(
          recordKeyOf(["auto-definitions", "x.yaml"]),
          new TextEncoder().encode("x"),
        ),
      ]);
      await unit.commit();
    });
  } finally {
    await writer.close();
  }
}

function caughtUp(repoDir: string): Promise<boolean> {
  return Deno.stat(swampPath(repoDir, "auto-definitions", "x.yaml")).then(
    () => true,
    () => false,
  );
}

/** The writer checkout sidecar as a writer at `fence` records it. */
async function plantSidecar(
  datastorePath: string,
  repoDir: string,
  writer: { pid: number; process: ProcessIdentity; fence: number },
): Promise<void> {
  await Deno.writeTextFile(
    join(datastorePath, "_control", "writer.checkout.json"),
    JSON.stringify({
      repoDir: await Deno.realPath(repoDir),
      hostname: Deno.hostname(),
      ...writer,
    }),
  );
}

/** A datastore and checkout with a commit the checkout has not caught up. */
async function withUncaughtCheckout(
  fn: (
    paths: { dir: string; datastorePath: string; repoDir: string },
  ) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir);
    await fn({ dir, datastorePath, repoDir });
  });
}

const config = (datastorePath: string) => ({
  type: "filesystem" as const,
  path: datastorePath,
});

Deno.test("v3RepositoryFactoryConfig: a reader does not catch up over a live writer on this kernel past its TTL (swamp-club#3564)", async () => {
  await withUncaughtCheckout(async ({ dir, datastorePath, repoDir }) => {
    // A live writer whose renewals stalled for longer than its TTL.
    const planted = await plantV3WriterLease(datastorePath, {
      pid: Deno.ppid,
      acquiredAt: new Date(Date.now() - 600_000),
      ttlMs: 30_000,
    });
    await plantSidecar(datastorePath, repoDir, {
      pid: Deno.ppid,
      process: await thisKernelIdentity(),
      fence: planted.fence,
    });
    await commitFromElsewhere(dir, datastorePath);
    await v3RepositoryFactoryConfig(repoDir, config(datastorePath));
    assertEquals(await caughtUp(repoDir), false);
  });
});

Deno.test("v3RepositoryFactoryConfig: a writer this process cannot judge is protected until a higher fence, then the reader's recovery fences it first (swamp-club#3564)", async () => {
  await withUncaughtCheckout(async ({ dir, datastorePath, repoDir }) => {
    // A container sharing this hostname, in another pid namespace.
    const kernel = await thisKernelIdentity();
    const elsewhere = { ...kernel, host: `${kernel.host}#pid:[4026532999]` };
    const planted = await plantV3WriterLease(datastorePath, {
      pid: 4242,
      process: elsewhere,
    });
    await plantSidecar(datastorePath, repoDir, {
      pid: 4242,
      process: elsewhere,
      fence: planted.fence,
    });
    await commitFromElsewhere(dir, datastorePath);
    // Within its TTL, and with its pid absent here: still protected.
    await v3RepositoryFactoryConfig(repoDir, config(datastorePath));
    assertEquals(await caughtUp(repoDir), false);
    await closeV3Datastores();

    // Past its TTL, with no marker to recover: protected until a higher
    // fence exists.
    const expired = await plantV3WriterLease(datastorePath, {
      pid: 4242,
      process: elsewhere,
      acquiredAt: new Date(Date.now() - 600_000),
      ttlMs: 30_000,
    });
    await plantSidecar(datastorePath, repoDir, {
      pid: 4242,
      process: elsewhere,
      fence: expired.fence,
    });
    await v3RepositoryFactoryConfig(repoDir, config(datastorePath));
    assertEquals(await caughtUp(repoDir), false);
    await closeV3Datastores();

    // Its marker, which a writer leaves while it writes: the reader's
    // recovery takes the lease, raising the fence the writer would commit
    // under, and only then catches up.
    await Deno.mkdir(join(writerMarkerPath(repoDir), ".."), {
      recursive: true,
    });
    await Deno.writeTextFile(
      writerMarkerPath(repoDir),
      JSON.stringify({
        hostname: Deno.hostname(),
        pid: 4242,
        process: elsewhere,
        since: 0,
      }),
    );
    await v3RepositoryFactoryConfig(repoDir, config(datastorePath));
    assertEquals(await caughtUp(repoDir), true);
    const stalled = openV3Datastore({ repoDir, datastorePath });
    try {
      assert((stalled.commitStore.writerFence() ?? 0) > expired.fence);
    } finally {
      await stalled.close();
    }
  });
});

Deno.test("v3RepositoryFactoryConfig: a force-released fence keeps its live writer's checkout protected until a higher fence (swamp-club#3564)", async () => {
  await withUncaughtCheckout(async ({ dir, datastorePath, repoDir }) => {
    const planted = await plantV3WriterLease(datastorePath, { pid: Deno.ppid });
    await plantSidecar(datastorePath, repoDir, {
      pid: Deno.ppid,
      process: await thisKernelIdentity(),
      fence: planted.fence,
    });
    await commitFromElsewhere(dir, datastorePath);
    const handle = v3WriterLockHandle(datastorePath);
    assert(await handle.forceRelease((await handle.inspect())!.nonce!));
    assertEquals(await handle.inspect(), null);
    await v3RepositoryFactoryConfig(repoDir, config(datastorePath));
    assertEquals(await caughtUp(repoDir), false);
  });
});

Deno.test("holdV3Writer: serve's retake of a lost hold records its checkout under the new fence (swamp-club#3564)", async () => {
  await withUncaughtCheckout(async ({ datastorePath, repoDir }) => {
    const sidecar = join(datastorePath, "_control", "writer.checkout.json");
    const recordedFence = async () =>
      JSON.parse(await Deno.readTextFile(sidecar)).fence;
    await holdV3Writer(config(datastorePath), repoDir, { retakeLost: true });
    assertEquals(await recordedFence(), 1);
    const handle = v3WriterLockHandle(datastorePath);
    assert(await handle.forceRelease((await handle.inspect())!.nonce!));
    await assertRejects(
      () => checkV3WriterLease(datastorePath),
      WriterFencedError,
    );
    // A caller joining the lost hold makes serve take the lease again.
    const release = await acquireV3WriterLock(datastorePath);
    try {
      assertEquals(v3WriterFence(datastorePath), 2);
      assertEquals(await recordedFence(), 2);
    } finally {
      await release();
    }
  });
});

Deno.test("tryAcquireV3WriterLock: a read-only recovery's hold records no writer checkout", async () => {
  await withUncaughtCheckout(async ({ datastorePath }) => {
    const release = await tryAcquireV3WriterLock(datastorePath);
    assert(release !== undefined);
    await release();
    await assertRejects(
      () => Deno.stat(join(datastorePath, "_control", "writer.checkout.json")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("holdV3Writer: a fenced command's retention pass does not join its lost hold, and its close leaves the new writer's checkout record (swamp-club#3564)", async () => {
  await withUncaughtCheckout(async ({ dir, datastorePath, repoDir }) => {
    const sidecar = join(datastorePath, "_control", "writer.checkout.json");
    // The command's own hold.
    await holdV3Writer(config(datastorePath), repoDir);
    // `lock release --force`, then another process writes another checkout.
    const handle = v3WriterLockHandle(datastorePath);
    assert(await handle.forceRelease((await handle.inspect())!.nonce!));
    const otherCheckout = join(dir, "other");
    await Deno.mkdir(otherCheckout);
    const other = await plantV3WriterLease(datastorePath, { pid: Deno.ppid });
    await plantSidecar(datastorePath, otherCheckout, {
      pid: Deno.ppid,
      process: await thisKernelIdentity(),
      fence: other.fence,
    });
    const before = await Deno.readTextFile(sidecar);
    // The retention pass at teardown opens the repository again.
    await assertRejects(
      () => holdV3Writer(config(datastorePath), repoDir),
      WriterFencedError,
    );
    assertEquals(await Deno.readTextFile(sidecar), before);
    await closeV3Datastores();
    assertEquals(await Deno.readTextFile(sidecar), before);
  });
});

Deno.test("v3RepositoryFactoryConfig: a writer whose boot id cannot be read still catches up its own checkout (swamp-club#3564)", async () => {
  await withUncaughtCheckout(async ({ dir, datastorePath, repoDir }) => {
    // Linux or macOS with no readable boot id: every record, this
    // process's own sidecar included, is one liveness cannot place.
    const { bootId: _, ...noBoot } = (await localProcess()).identity;
    setLocalProcessForTesting({
      pid: Deno.pid,
      identity: noBoot,
      probe: probeProcess,
      bootIdRequired: true,
    });
    try {
      await commitFromElsewhere(dir, datastorePath);
      await holdV3Writer(config(datastorePath), repoDir);
      await v3RepositoryFactoryConfig(repoDir, config(datastorePath));
      assertEquals(await caughtUp(repoDir), true);
    } finally {
      setLocalProcessForTesting(undefined);
    }
  });
});

Deno.test("v3RepositoryFactoryConfig: a reserved namespace is refused with the v3 way off it (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir);
    for (const namespace of ["data", "vault"]) {
      const error = await assertRejects(
        () =>
          v3RepositoryFactoryConfig(repoDir, {
            type: "filesystem",
            path: datastorePath,
            namespace,
          }),
        UserError,
        `Namespace "${namespace}" has the same name as a datastore layout directory`,
      );
      assert(
        error.message.includes("new, empty v3 datastore"),
        error.message,
      );
      assert(
        !error.message.includes("swamp datastore namespace set"),
        "v3 refuses namespace set, so the remedy cannot name it",
      );
      assertEquals(error.code, V3_RESERVED_NAMESPACE_CODE);
    }
    // Refused before anything opened: no read model state was made.
    assertEquals(
      await Deno.stat(swampPath(repoDir, "_read_model_v3")).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

Deno.test("holdV3Writer: a reserved namespace is refused before the writer lock or recovery (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir);
    const reserved = {
      type: "filesystem" as const,
      path: datastorePath,
      namespace: "vault",
    };
    await assertRejects(
      () => holdV3Writer(reserved, repoDir),
      UserError,
      'Namespace "vault"',
    );
    assertEquals(holdsV3WriterLock(datastorePath), false);
  });
});

Deno.test("v3RepositoryFactoryConfig: a .swamp/data linking out of .swamp is refused at open (swamp-club#3691)", async () => {
  if (Deno.build.os === "windows") return;
  await withUncaughtCheckout(async ({ dir, datastorePath, repoDir }) => {
    const outside = join(dir, "elsewhere");
    await Deno.mkdir(outside);
    await Deno.mkdir(swampPath(repoDir), { recursive: true });
    await Deno.symlink(outside, swampPath(repoDir, "data"), { type: "dir" });
    await assertRejects(
      () => v3RepositoryFactoryConfig(repoDir, config(datastorePath)),
      UserError,
      `${swampPath(repoDir, "data")} resolves to ${await Deno.realPath(
        outside,
      )}, outside`,
    );
    await assertRejects(
      () => holdV3Writer(config(datastorePath), repoDir),
      UserError,
      "Replace",
    );
    assertEquals(holdsV3WriterLock(datastorePath), false);
    assertEquals([...Deno.readDirSync(outside)], []);
  });
});

Deno.test("v3RepositoryFactoryConfig: a link out of a namespace's cache root is refused, one inside .swamp is not (swamp-club#3691)", async () => {
  if (Deno.build.os === "windows") return;
  await withUncaughtCheckout(async ({ dir, datastorePath, repoDir }) => {
    const outside = join(dir, "elsewhere");
    await Deno.mkdir(outside);
    // Inside .swamp: harmless, and opened.
    const inside = swampPath(repoDir, "data-real");
    await Deno.mkdir(inside, { recursive: true });
    await Deno.symlink(inside, swampPath(repoDir, "data"), { type: "dir" });
    await commitFromElsewhere(dir, datastorePath);
    await v3RepositoryFactoryConfig(repoDir, config(datastorePath));
    assertEquals(await caughtUp(repoDir), true);
    await closeV3Datastores();
    // Out of the namespace's own cache root: refused.
    await Deno.mkdir(swampPath(repoDir, "team-a"), { recursive: true });
    await Deno.symlink(outside, swampPath(repoDir, "team-a", "outputs"), {
      type: "dir",
    });
    const escaped = await assertRejects(
      () =>
        v3RepositoryFactoryConfig(repoDir, {
          ...config(datastorePath),
          namespace: "team-a",
        }),
      UserError,
      swampPath(repoDir, "team-a", "outputs"),
    );
    assertEquals(escaped.code, V3_CACHE_ROOT_ESCAPE_CODE);
  });
});

Deno.test("v3RepositoryFactoryConfig: a solo-root link out of .swamp in a subdirectory the checkout leaves out is not refused (swamp-club#3691)", async () => {
  if (Deno.build.os === "windows") return;
  await withUncaughtCheckout(async ({ dir, datastorePath, repoDir }) => {
    const outside = join(dir, "elsewhere");
    await Deno.mkdir(outside);
    await Deno.mkdir(swampPath(repoDir), { recursive: true });
    await Deno.symlink(outside, swampPath(repoDir, "data"), { type: "dir" });
    await v3RepositoryFactoryConfig(repoDir, {
      ...config(datastorePath),
      directories: ["auto-definitions"],
    });
  });
});

// ── Another namespace's content (swamp-club#3691) ───────────────────────────

const FOREIGN_KEY = "data/test/model/m-1/state/1/raw";

/** Writes `text` at `key` under `root`, creating its directories. */
async function plant(root: string, key: string, text: string): Promise<void> {
  const path = join(root, ...key.split("/"));
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/**
 * The fetcher the factory gives checkout `alpha` of a fresh v3 datastore,
 * with the checkout's `.swamp/`.
 */
async function alphaFetcher(
  dir: string,
  config: { namespace?: string; exclude?: string[] } = { namespace: "alpha" },
) {
  const datastorePath = join(dir, "datastore");
  await initializeV3Datastore(datastorePath, "test");
  const repoDir = join(dir, "alpha");
  await Deno.mkdir(repoDir);
  const factory = await v3RepositoryFactoryConfig(repoDir, {
    type: "filesystem",
    path: datastorePath,
    ...config,
  });
  const fetcher = factory.fetchForeignContent;
  assert(fetcher !== undefined, "the v3 context has a foreign fetcher");
  return { fetcher, swamp: swampPath(repoDir) };
}

const text = (bytes: Uint8Array | null) =>
  bytes === null ? null : new TextDecoder().decode(bytes);

Deno.test("v3RepositoryFactoryConfig: the foreign fetcher reads another namespace's cache root, never the checkout's own, and reads the solo namespace (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const { fetcher, swamp } = await alphaFetcher(dir);
    assertEquals(fetcher.readsSoloNamespace, true);
    // The reader's own item lives at the same key under its own root.
    await plant(join(swamp, "alpha"), FOREIGN_KEY, '{"who":"alpha"}');
    await plant(join(swamp, "beta"), FOREIGN_KEY, '{"who":"beta"}');
    await plant(swamp, FOREIGN_KEY, '{"who":"solo"}');

    assertEquals(text(await fetcher("beta", FOREIGN_KEY)), '{"who":"beta"}');
    assertEquals(text(await fetcher("", FOREIGN_KEY)), '{"who":"solo"}');
    assertEquals(await fetcher("gamma", FOREIGN_KEY), null, "absent file");
  });
});

Deno.test("v3RepositoryFactoryConfig: the foreign fetcher refuses reserved namespaces and paths that leave the namespace's tree (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const { fetcher, swamp } = await alphaFetcher(dir);
    // `data` is a reserved name: `.swamp/data` is the solo namespace's tier.
    await plant(join(swamp, "data"), FOREIGN_KEY, "solo tier");
    await plant(join(swamp, "beta"), "data/x", "x");

    assertEquals(await fetcher("data", FOREIGN_KEY), null);
    for (
      const [namespace, relPath] of [
        ["..", FOREIGN_KEY],
        ["a/b", FOREIGN_KEY],
        ["beta", "data/../data/x"],
        ["beta", "../beta/data/x"],
        ["beta", "/data/x"],
        ["beta", "data//x"],
        ["beta", "data\\x"],
      ]
    ) {
      assertEquals(
        await fetcher(namespace, relPath),
        null,
        `${namespace}:${relPath}`,
      );
    }
    // The same file under a key the read model materialises is read.
    assertEquals(text(await fetcher("beta", "data/x")), "x");
  });
});

Deno.test("v3RepositoryFactoryConfig: the foreign fetcher refuses a solo key this checkout's directories leave out, which is a local file there (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const { fetcher, swamp } = await alphaFetcher(dir, {
      namespace: "alpha",
      exclude: ["data/test/model/m-1/**"],
    });
    await plant(swamp, FOREIGN_KEY, "local");
    await plant(join(swamp, "beta"), FOREIGN_KEY, "beta");

    assertEquals(await fetcher("", FOREIGN_KEY), null);
    // Another namespace's checkouts keep their own directories.
    assertEquals(text(await fetcher("beta", FOREIGN_KEY)), "beta");
  });
});

Deno.test({
  name:
    "v3RepositoryFactoryConfig: the foreign fetcher refuses a path a symlink takes outside the namespace's cache root (swamp-club#3691)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const { fetcher, swamp } = await alphaFetcher(dir);
      const outside = join(dir, "outside");
      await plant(outside, "state/1/raw", "outside");
      await Deno.mkdir(join(swamp, "beta", "data", "test", "model", "m-1"), {
        recursive: true,
      });
      await Deno.symlink(
        join(outside, "state"),
        join(swamp, "beta", "data", "test", "model", "m-1", "state"),
        { type: "dir" },
      );

      assertEquals(await fetcher("beta", FOREIGN_KEY), null);
    });
  },
});

/**
 * A set-up bucket datastore's provider whose datastore-wide control plane
 * writes fail with `failure()`, once `seeded` has written its marker.
 */
async function failingControlPlaneProvider(
  failure: () => Error,
): Promise<DatastoreProvider> {
  const remote = createInMemoryRemote({
    controlPlane: true,
    storage: true,
    replicaTarget: {
      type: "s3",
      bucket: "team-bucket",
      prefix: "",
      region: "us-east-1",
    },
    replicaPaths: true,
  });
  const store = remote.datastoreControlPlaneStore!();
  // The datastore was set up: its format marker is there to read.
  const seeded = store.put(
    "datastore-format",
    new TextEncoder().encode('{"format":3,"minReaderFormat":3}'),
  );
  const failing = new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (
        !["put", "putIfAbsent", "delete"].includes(String(property))
      ) {
        return value.bind(target);
      }
      return () => Promise.reject(failure());
    },
  });
  await seeded;
  return {
    createLock: () => {
      throw new Error("not used");
    },
    createVerifier: () => {
      throw new Error("not used");
    },
    resolveDatastorePath: (repoDir) => join(repoDir, ".swamp"),
    datastoreWideLease: true,
    datastoreControlPlaneStore: () => failing,
    storage: () => remote.storage!(),
    replicaTarget: () => remote.replicaTarget!(),
    replicaPaths: () => remote.replicaPaths!(),
  };
}

const BUCKET_CONFIG: CustomDatastoreConfig = {
  type: "@test/bucket",
  config: {},
  datastorePath: "/unused",
  format: 3,
};

Deno.test("holdV3Writer: a datastore whose storage cannot be reached while the lease is taken fails with the storage-unreachable code (swamp-club#3802)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir, { recursive: true });
    try {
      const location = bindV3BucketDatastore(
        repoDir,
        { ...BUCKET_CONFIG },
        await failingControlPlaneProvider(() =>
          new Error("S3 putObjectConditional failed key=_control/writer/x", {
            cause: Object.assign(new Error("read ECONNRESET"), {
              code: "ECONNRESET",
            }),
          })
        ),
        { platform: { os: "linux", arch: "x86_64" } },
      );
      const error = await assertRejects(
        () => holdV3Writer(location, repoDir),
        V3StorageUnreachableError,
      );
      assertEquals(error.code, V3_STORAGE_UNREACHABLE_CODE);
      assertStringIncludes(error.message, "nothing was changed");
      assertStringIncludes(error.message, "putObjectConditional");
    } finally {
      resetV3BucketBindingsForTesting();
    }
  });
});

Deno.test("holdV3Writer: a storage failure that is not a network failure keeps its own error (swamp-club#3802)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir, { recursive: true });
    try {
      const location = bindV3BucketDatastore(
        repoDir,
        { ...BUCKET_CONFIG },
        await failingControlPlaneProvider(() =>
          new Error("HTTP 403 forbidden")
        ),
        { platform: { os: "linux", arch: "x86_64" } },
      );
      const error = await assertRejects(
        () => holdV3Writer(location, repoDir),
        Error,
        "HTTP 403 forbidden",
      );
      assert(!(error instanceof V3StorageUnreachableError));
    } finally {
      resetV3BucketBindingsForTesting();
    }
  });
});

Deno.test({
  name:
    "holdV3Writer: a lease release that fails after the hold's restore failed never replaces the error getting ready failed with (swamp-club#3802)",
  // Litestream replication needs a Unix user id.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      await Deno.mkdir(repoDir, { recursive: true });
      const remote = createInMemoryRemote({
        controlPlane: true,
        storage: true,
        replicaTarget: {
          type: "s3",
          bucket: "team-bucket",
          prefix: "",
          region: "us-east-1",
        },
        replicaPaths: true,
      });
      const store = remote.datastoreControlPlaneStore!();
      await store.put(
        "datastore-format",
        new TextEncoder().encode('{"format":3,"minReaderFormat":3}'),
      );
      // The lease's fence is created. Getting ready then fails with an error
      // of its own (the lineage record is refused), and the release that
      // follows is cut off, as the reporter's was.
      let releases = 0;
      const cut = new Proxy(store, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          if (property !== "putIfAbsent") return value.bind(target);
          return (key: string, ...rest: unknown[]) => {
            if (key.includes("released")) {
              releases++;
              return Promise.reject(
                new Error(`S3 putObjectConditional failed key=${key}`, {
                  cause: Object.assign(new Error("read ECONNRESET"), {
                    code: "ECONNRESET",
                  }),
                }),
              );
            }
            if (key.startsWith("writer/")) {
              return value.apply(target, [key, ...rest]);
            }
            return Promise.reject(new Error("HTTP 412 lineage refused"));
          };
        },
      });
      try {
        const location = bindV3BucketDatastore(
          repoDir,
          { ...BUCKET_CONFIG },
          {
            createLock: () => {
              throw new Error("not used");
            },
            createVerifier: () => {
              throw new Error("not used");
            },
            resolveDatastorePath: (repo) => join(repo, ".swamp"),
            datastoreWideLease: true,
            datastoreControlPlaneStore: () => cut,
            storage: () => remote.storage!(),
            replicaTarget: () => remote.replicaTarget!(),
            replicaPaths: () => remote.replicaPaths!(),
          },
          { platform: { os: "linux", arch: "x86_64" } },
        );
        const error = await assertRejects(() =>
          holdV3Writer(location, repoDir)
        );
        assertEquals(releases, 1, "the release was attempted");
        assert(error instanceof Error, String(error));
        assertStringIncludes(error.message, "HTTP 412 lineage refused");
        assert(
          !error.message.includes("putObjectConditional failed"),
          error.message,
        );
      } finally {
        resetV3BucketBindingsForTesting();
      }
    });
  },
});
