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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
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
  holdV3Writer,
  v3DatastoreFor,
  V3MaintenanceTimer,
  v3RepositoryFactoryConfig,
} from "./v3_repo_context.ts";
import { holdsV3WriterLock, v3WriterFence } from "./v3_writer_lock.ts";
import { plantV3WriterLease } from "./v3_writer_lock_test_helpers.ts";

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

/** A handle whose compaction is counted and can be held open. */
function fakeHandle() {
  let calls = 0;
  let sweeps = 0;
  let release: () => void = () => {};
  const handle = {
    datastorePath: "/fake",
    compactIfDue: () => {
      calls++;
      return new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
    },
    collectChunks: () => {
      sweeps++;
      return Promise.resolve({ deleted: 0 });
    },
  } as unknown as V3Datastore;
  return {
    handle,
    calls: () => calls,
    sweeps: () => sweeps,
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
  timer.tick();
  assertEquals(fake.calls(), 2, "the next tick runs again");
  fake.finish();
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

Deno.test("compactQuietly: a failing compaction is logged, not thrown", async () => {
  const handle = {
    datastorePath: "/fake",
    compactIfDue: () => Promise.reject(new Error("disk full")),
  } as unknown as V3Datastore;
  await compactQuietly(handle);
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
