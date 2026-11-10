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
import { dirname, join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import {
  isFreshV3Skeleton,
  v3CommitsDbPath,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { lineageRegistryFor } from "../src/infrastructure/datastore_v3/litestream/v3_copy.ts";
import { V3_RESTORE_FAILED_CODE } from "../src/infrastructure/datastore_v3/litestream/litestream_restorer.ts";
import { replicaPathFor } from "../src/domain/datastore_v3/replication_lineage.ts";
import { V3_REPLICATION_UNCONFIRMED_CODE } from "../src/domain/datastore_v3/litestream_replication.ts";
import { WRITER_FENCED_CODE } from "../src/domain/datastore_v3/writer_lease.ts";
import {
  ignore,
  type Machine,
  MachineError,
  read,
  S3_ENDPOINT,
  STALL_MS,
  withMachines,
  type World,
} from "./datastore_v3_litestream_restore_helpers.ts";

Deno.test({
  name:
    "v3 restore harness: a machine that never answers fails its request, naming it, and later requests fail at once",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await assertRejects(
        () => a.send({ kind: "spin", ms: 30_000 }, { timeoutMs: 500 }),
        Error,
        "machine-a: spin did not answer within 500ms",
      );
      await assertRejects(
        () => a.send({ kind: "fence" }),
        Error,
        "machine-a: spin did not answer",
      );
    });
  },
});

Deno.test({
  name:
    "v3 restore harness: teardown does not wait behind a request still in flight",
  ignore: Deno.build.os === "windows",
  async fn() {
    let stuck: Promise<unknown> | undefined;
    await withMachines(async (world) => {
      const a = await world.machine("a");
      stuck = a.send({ kind: "spin", ms: 30_000 });
    });
    await assertRejects(
      () => stuck!,
      Error,
      "machine-a: abandoned at teardown",
    );
  },
});

Deno.test({
  name:
    "v3 restore: a fresh checkout restores and sees every acknowledged commit",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 3, close: true });
      const b = await world.machine("b");
      const seen = await read(b);
      assertEquals(seen.commits, 3);
      assert(seen.restored !== null, "the fresh checkout restored");
    });
  },
});

Deno.test({
  name:
    "v3 restore: a claim one machine writes reaches the next machine's restore, which refuses to write, and a release lets it write (swamp-club#4063)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 1, close: true });
      await a.send({ kind: "claim", address: "https://swamp.example.com" });
      const b = await world.machine("b");
      const refused = await assertRejects(
        () => b.send({ kind: "write", commits: 1, close: true }),
        MachineError,
        "https://swamp.example.com",
      );
      assertEquals(refused.code, "datastore_claimed");
      await b.send({ kind: "close" });
      assertEquals((await read(b)).commits, 1);
      await a.send({ kind: "release" });
      await b.send({ kind: "write", commits: 1, close: true });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 2);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a refusal on a checkout whose own outbox holds an earlier command's commits names how many and where they stay (swamp-club#4063)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true });
      const outbox = await b.send({ kind: "plantOutboxEntry" }) as string;
      await a.send({ kind: "claim", address: "https://swamp.example.com" });
      const refused = await assertRejects(
        () => b.send({ kind: "write", commits: 1, close: true }),
        MachineError,
      );
      assertEquals(refused.code, "datastore_claimed");
      assertStringIncludes(refused.message, "1 commit an earlier command");
      assertStringIncludes(refused.message, outbox);
      assertStringIncludes(refused.message, "not sent through serve");
      assertStringIncludes(refused.message, "swamp datastore release");
      assertStringIncludes(refused.message, "Nothing was changed.");
      await b.send({ kind: "close" });
    });
  },
});

Deno.test({
  name:
    "v3 restore: a stale copy's claim, met with a busy lease, is refused as the copy's, and the write goes ahead once the lease is free (swamp-club#4063)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      const b = await world.machine("b");
      await a.send({ kind: "claim", address: "https://swamp.example.com" });
      await read(b);
      await a.send({ kind: "release" });
      await a.send({ kind: "lease", ttlMs: 60_000 });
      const refused = await assertRejects(
        () => b.send({ kind: "write", commits: 1, close: true }),
        MachineError,
        "last copy of the datastore shows the claim",
      );
      assertEquals(refused.code, "datastore_claimed");
      await b.send({ kind: "close" });
      await a.send({ kind: "close" });
      await b.send({ kind: "write", commits: 1, close: true });
      assertEquals((await read(b)).commits, 1);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a stale reader refreshes, and a current one downloads nothing",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      const b = await world.machine("b");
      await a.send({ kind: "write", commits: 2, close: true });
      assertEquals((await read(b)).commits, 2);
      const current = await read(b);
      assertEquals(current, { commits: 2, restored: null });
      await a.send({ kind: "write", commits: 3, close: true });
      const refreshed = await read(b);
      assertEquals(refreshed.commits, 5);
      assert(refreshed.restored !== null, "the stale reader refreshed");
    });
  },
});

Deno.test({
  name:
    "v3 restore: a takeover restores before writing, starts a new lineage and keeps every acknowledged commit",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      const before = await world.lineages();
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true });
      const after = await world.lineages();
      assert(
        after.current !== undefined && after.current > before.current!,
        `a new lineage is current: ${JSON.stringify({ before, after })}`,
      );
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 3);
      await a.send({ kind: "write", commits: 1, close: true });
      assertEquals((await read(c)).commits, 4);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a zombie paused past its lease and resumed after a takeover lands nothing",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "lease", ttlMs: 1_500 });
      await a.send({ kind: "write", commits: 1, close: false });
      // Its read model applies the zombie commit, at the cursor the
      // takeover's first commit will have.
      await a.send({ kind: "catchUp" });
      const zombieFiles = await a.send({ kind: "files" }) as string[];
      assertEquals(zombieFiles.length, 3);
      const paused = a.send({ kind: "pause", ms: STALL_MS });
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true });
      assertEquals((await read(b)).commits, 3, "the takeover saw no zombie");
      await paused;
      // The zombie resumes: it syncs and publishes on its old lineage, and
      // its lease check fails. It is told its changes may or may not
      // appear, not that nothing was committed.
      const closed = await assertRejects(() => a.send({ kind: "close" }));
      assertEquals((closed as MachineError).code, WRITER_FENCED_CODE);
      assertStringIncludes(
        (closed as MachineError).message,
        "They appear only if",
      );
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 3);
      assertEquals((await read(b)).commits, 3);
      // the zombie's copy is restored from the takeover's lineage, where the
      // commit at its read model's cursor differs, so the read model replays
      // and holds only acknowledged records
      assertEquals((await read(a)).commits, 3);
      const files = await a.send({ kind: "files" }) as string[];
      assertEquals(files.length, 3);
      assertEquals(files, await c.send({ kind: "files" }));
    });
  },
});

Deno.test({
  name:
    "v3 restore: a writer killed before its first confirmed sync never becomes the current state",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      const before = await world.lineages();
      const b = await world.machine("b");
      // Its lineage is started and its sidecar uploads, but it never
      // confirms a sync.
      await b.send({ kind: "write", commits: 1, close: false });
      await b.crash();
      const after = await world.lineages();
      assert(after.newestStarted! > before.current!, "b started a lineage");
      assertEquals(after.current, before.current);
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 2);
    });
  },
});

Deno.test({
  name: "v3 restore: a lease taken on a stale copy never continues its lineage",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      const b = await world.machine("b");
      await a.send({ kind: "write", commits: 1, close: true });
      await b.send({ kind: "write", commits: 1, close: true });
      await a.send({ kind: "lease", ttlMs: 30_000 });
      await a.send({ kind: "close" });
      await a.send({ kind: "write", commits: 1, close: true });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 3);
    });
  },
});

Deno.test({
  name:
    "v3 restore: GC removes only abandoned lineage paths under the current root",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 1, close: true });
      await a.send({ kind: "write", commits: 1, close: true });
      const first = (await world.lineages()).current!;
      assertEquals(first, 1);
      // A record planted at fence 2, whose path is a symlink out of the
      // replica: GC must not follow it.
      const outside = join(world.root, "outside");
      await Deno.mkdir(outside);
      await Deno.writeTextFile(join(outside, "keep"), "x");
      await Deno.mkdir(join(world.replicaRoot, "_litestream"), {
        recursive: true,
      });
      await Deno.symlink(outside, replicaPathFor(world.replicaRoot, 2), {
        type: "dir",
      });
      await withMockedEnv({ [V3_REPLICA_ENV]: world.replica }, async () => {
        await lineageRegistryFor(world.datastorePath).start({
          fence: 2,
          holder: "planted",
          replicaRoot: `file:${world.replicaRoot}`,
          startedAt: new Date().toISOString(),
        });
      });
      // A's idle sidecar exits, as it would after its idle timeout:
      // nothing writes the abandoned path while GC removes it.
      await a.stopSidecars();
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true });
      const second = (await world.lineages()).current!;
      assert(second > first);
      const exists = (path: string) =>
        Deno.lstat(path).then(() => true, () => false);
      await waitFor(
        async () => !await exists(replicaPathFor(world.replicaRoot, first)),
        "the abandoned lineage's path to go",
      );
      assert(await exists(replicaPathFor(world.replicaRoot, second)));
      assertEquals(await Deno.readTextFile(join(outside, "keep")), "x");
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 3);
    });
  },
});

Deno.test({
  name:
    "v3 restore: setup on a second checkout never takes a written datastore for a fresh one",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 1, close: true });
      await withMockedEnv({ [V3_REPLICA_ENV]: world.replica }, async () => {
        assertEquals(await isFreshV3Skeleton(world.datastorePath), false);
      });
    });
  },
});

Deno.test({
  name: "v3 restore: a fresh checkout restores from an S3 replica (opt-in)",
  ignore: ignore || S3_ENDPOINT === undefined,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      const b = await world.machine("b");
      assertEquals((await read(b)).commits, 2);
      await b.send({ kind: "write", commits: 1, close: true });
      assertEquals((await read(a)).commits, 3);
    }, {
      replica: () =>
        JSON.stringify({
          type: "s3",
          bucket: Deno.env.get("SWAMP_TEST_LITESTREAM_S3_BUCKET") ??
            "swamp-test",
          path: `ls-${crypto.randomUUID()}`,
          endpoint: S3_ENDPOINT,
          region: "us-east-1",
        }),
    });
  },
});

Deno.test({
  name:
    "v3 restore: namespace list brings a stale checkout's copy up to date first (swamp-club#3491)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a", { namespace: "alpha" });
      await a.send({ kind: "write", commits: 1, close: true });
      const b = await world.machine("b");
      assertEquals(await b.send({ kind: "namespaces" }), ["alpha"]);
    });
  },
});

Deno.test({
  name:
    "v3 restore: turning replication on publishes the shared commits.db as the first lineage (swamp-club#3491)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const before = await world.machine("before", { replica: "" });
      await before.send({ kind: "write", commits: 3, close: true });
      const first = await world.machine("first", { checkout: "before" });
      await first.send({ kind: "write", commits: 1, close: true });
      assertEquals((await read(first)).commits, 4);
      const fresh = await world.machine("fresh");
      assertEquals((await read(fresh)).commits, 4);
    });
  },
});

Deno.test({
  name:
    "v3 restore: chunks are not collected while another lineage may still be restored (swamp-club#3491)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "write", commits: 0, close: false });
      assertEquals(await a.send({ kind: "gc" }), null);
      // A lineage another writer started, which it may yet confirm.
      const current = (await world.lineages()).current!;
      await withMockedEnv({ [V3_REPLICA_ENV]: world.replica }, async () => {
        await lineageRegistryFor(world.datastorePath).start({
          fence: current + 10,
          holder: "other@host",
          replicaRoot: `file:${world.replicaRoot}`,
          startedAt: new Date().toISOString(),
        });
      });
      const deferred = await a.send({ kind: "gc" }) as string | null;
      assert(
        deferred !== null && deferred.includes("not collected yet"),
        `gc: ${deferred}`,
      );
      assertStringIncludes(deferred, "may still be restored");
      await a.send({ kind: "close" });
    });
  },
});

Deno.test({
  name:
    "v3 restore: a failed close's commits are dropped with a warning when another checkout writes first (swamp-club#3565)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a", { captureWarnings: true });
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "write", commits: 1, close: false });
      const sidecars = await a.send({ kind: "pids" }) as number[];
      for (const pid of sidecars) {
        hostLitestreamProcesses.signalGroup(pid, "SIGKILL");
      }
      await waitFor(
        () => sidecars.every((pid) => !hostLitestreamProcesses.isAlive(pid)),
        "A's sidecar to stop",
      );
      const refused = await assertRejects(
        () => a.send({ kind: "close" }),
        MachineError,
      );
      assertEquals(refused.code, V3_REPLICATION_UNCONFIRMED_CODE);
      assertStringIncludes(
        refused.message,
        "if another checkout writes to the datastore first, they are lost",
      );
      await a.send({ kind: "warnings" });
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true });
      await a.send({ kind: "write", commits: 1, close: true });
      const warned = await a.send({ kind: "warnings" }) as string[];
      assert(
        warned.some((message) =>
          message.includes("dropped 1 commit(s) the replica never confirmed")
        ),
        `A's warnings: ${JSON.stringify(warned)}`,
      );
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 4);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a copy left as an empty file is restored over (swamp-club#3565)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      // A reader that stopped waiting for a restore may leave an empty file
      // where the copy goes; counting what the restore drops from it fails.
      const empty = await withMockedEnv(
        { [V3_REPLICA_ENV]: world.replica },
        () =>
          Promise.resolve(
            v3CommitsDbPath(world.datastorePath, join(world.root, "b")),
          ),
      );
      await Deno.mkdir(dirname(empty), { recursive: true });
      await Deno.writeTextFile(empty, "");
      const b = await world.machine("b");
      assertEquals((await read(b)).commits, 2);
    });
  },
});

/**
 * makes the lineage replica path unreadable like a bucket answering 404; the
 * writer's sidecars stop first so none rewrites the path
 */
async function hideCurrentLineage(
  world: World,
  writer: Machine,
): Promise<void> {
  await writer.stopSidecars();
  const fence = (await world.lineages()).current!;
  const path = replicaPathFor(world.replicaRoot, fence);
  await Deno.rename(path, `${path}.hidden`);
}

Deno.test({
  name:
    "v3 restore: a fresh checkout whose restore fails refuses to read instead of reading an empty datastore (swamp-club#3642)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      await hideCurrentLineage(world, a);
      const b = await world.machine("b");
      for (let attempt = 0; attempt < 2; attempt++) {
        const refused = await assertRejects(() => read(b), MachineError);
        assertEquals(refused.code, V3_RESTORE_FAILED_CODE);
        assertStringIncludes(
          refused.message,
          "Restoring the v3 datastore copy failed",
        );
      }
      const write = await assertRejects(
        () => b.send({ kind: "write", commits: 1, close: true }),
        MachineError,
      );
      assertEquals(write.code, V3_RESTORE_FAILED_CODE);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a copy left as an empty file by a waiting reader still counts as never restored (swamp-club#3642)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      await hideCurrentLineage(world, a);
      const empty = await withMockedEnv(
        { [V3_REPLICA_ENV]: world.replica },
        () =>
          Promise.resolve(
            v3CommitsDbPath(world.datastorePath, join(world.root, "b")),
          ),
      );
      await Deno.mkdir(dirname(empty), { recursive: true });
      await Deno.writeTextFile(empty, "");
      const b = await world.machine("b");
      const refused = await assertRejects(() => read(b), MachineError);
      assertEquals(refused.code, V3_RESTORE_FAILED_CODE);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a fresh checkout whose restore cannot run refuses to read with the restore's code (swamp-club#3642)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      const b = await world.machine("b", { binaryMissing: true });
      const refused = await assertRejects(() => read(b), MachineError);
      assertEquals(refused.code, V3_RESTORE_FAILED_CODE);
      assertStringIncludes(
        refused.message,
        "no Litestream binary on this host",
      );
    });
  },
});

Deno.test({
  name:
    "v3 restore: a fresh checkout that cannot take the restore lock refuses to read (swamp-club#3642)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      // The copy's directory, as another process restoring it made it; no
      // commits.db yet.
      const copyDb = await withMockedEnv(
        { [V3_REPLICA_ENV]: world.replica },
        () =>
          Promise.resolve(
            v3CommitsDbPath(world.datastorePath, join(world.root, "b")),
          ),
      );
      await Deno.mkdir(dirname(copyDb), { recursive: true });
      const b = await world.machine("b", { lockTimeoutMs: 500 });
      const lockPath = await b.send({ kind: "restoreLock" }) as string;
      await Deno.mkdir(dirname(lockPath), { recursive: true });
      const lock = await Deno.open(lockPath, {
        read: true,
        write: true,
        create: true,
      });
      await lock.lock(true);
      try {
        const refused = await assertRejects(() => read(b), MachineError);
        assertEquals(refused.code, V3_RESTORE_FAILED_CODE);
        assertStringIncludes(
          refused.message,
          "another swamp process is restoring this checkout's copy",
        );
      } finally {
        await lock.unlock();
        lock.close();
      }
      assertEquals((await read(b)).commits, 2);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a restored copy whose refresh fails is read as it is, with one warning (swamp-club#3642)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      const b = await world.machine("b", { captureWarnings: true });
      assertEquals((await read(b)).commits, 2);
      await a.send({ kind: "write", commits: 1, close: true });
      await hideCurrentLineage(world, a);
      assertEquals(await read(b), { commits: 2, restored: null });
      const warned = (await b.send({ kind: "warnings" }) as string[]).filter(
        (message) => message.includes("could not be brought up to date"),
      );
      assertEquals(warned.length, 1, JSON.stringify(warned));
      assertStringIncludes(
        warned[0],
        "Restoring the v3 datastore copy failed",
      );
    });
  },
});
