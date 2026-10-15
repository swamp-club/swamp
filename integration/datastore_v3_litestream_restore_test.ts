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
 * Restore, refresh and takeover from the v3 replica (swamp-club#3482,
 * Phase 4 D2), against a real Litestream with a file replica. Each
 * "machine" is a worker with its own module state, host name and checkout,
 * on one filesystem-v3 datastore: two checkouts behave like two machines
 * on a bucket. Ignored without `SWAMP_LITESTREAM_PATH`, and on Windows.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import {
  initializeV3Datastore,
  isFreshV3Skeleton,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { lineageRegistryFor } from "../src/infrastructure/datastore_v3/litestream/v3_copy.ts";
import {
  currentLineage,
  newestStartedFence,
} from "../src/domain/datastore_v3/published_lineage.ts";
import { replicaPathFor } from "../src/domain/datastore_v3/replication_lineage.ts";
import { WRITER_FENCED_CODE } from "../src/domain/datastore_v3/writer_lease.ts";
import { SIDECAR_TESTS_IGNORED } from "./datastore_v3_litestream_helpers.ts";
import type {
  MachineRequest,
  MachineResponse,
} from "./datastore_v3_litestream_machine_worker.ts";

const ignore = SIDECAR_TESTS_IGNORED;

/**
 * How long a stalled machine stops: past its 1.5 s lease, plus the 10 s
 * the lease allows for clock skew (`WRITER_LEASE_CLOCK_SKEW_MS`).
 */
const STALL_MS = 14_000;

/** A machine: requests run one at a time, in order. */
interface Machine {
  send(request: MachineRequest): Promise<unknown>;
  /** Ends the worker as a crash would: no teardown. */
  crash(): Promise<void>;
  /** Kills the sidecars this machine launched, as an idle exit ends them. */
  stopSidecars(): Promise<void>;
}

interface World {
  readonly root: string;
  readonly datastorePath: string;
  readonly replicaRoot: string;
  readonly replica: string;
  machine(name: string): Promise<Machine>;
  /** What the published lineages say, as a reader sees them. */
  lineages(): Promise<{ current?: number; newestStarted?: number }>;
}

class MachineError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function withMachines(
  fn: (world: World) => Promise<void>,
  options: { readonly replica?: (root: string) => string } = {},
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-ls-d2-" }),
  );
  const datastorePath = join(root, "ds");
  const replicaRoot = join(root, "replica");
  const privateRoot = join(root, "priv");
  const replica = options.replica?.(root) ??
    JSON.stringify({ type: "file", path: replicaRoot });
  await withMockedEnv(
    { [V3_REPLICA_ENV]: replica },
    () => initializeV3Datastore(datastorePath, "test"),
  );
  const workers: { worker: Worker; pids: () => Promise<number[]> }[] = [];
  const pids = new Set<number>();
  const world: World = {
    root,
    datastorePath,
    replicaRoot,
    replica,
    async machine(name) {
      const worker = new Worker(
        new URL("./datastore_v3_litestream_machine_worker.ts", import.meta.url),
        { type: "module" },
      );
      let queue: Promise<unknown> = Promise.resolve();
      let alive = true;
      const call = (request: MachineRequest) =>
        new Promise<unknown>((done, fail) => {
          worker.onmessage = (event: MessageEvent<MachineResponse>) => {
            const response = event.data;
            if (response.ok) done(response.value);
            else fail(new MachineError(response.error, response.code));
          };
          worker.onerror = (event) => {
            event.preventDefault();
            fail(new Error(event.message));
          };
          worker.postMessage(request);
        });
      const send = (request: MachineRequest) => {
        const next = queue.then(() => call(request));
        queue = next.catch(() => {});
        return next;
      };
      const remember = async () => {
        if (!alive) return [];
        const launched = await send({ kind: "pids" }) as number[];
        for (const pid of launched) pids.add(pid);
        return launched;
      };
      workers.push({ worker, pids: remember });
      await send({
        kind: "init",
        hostname: `machine-${name}`,
        replica,
        privateRoot,
        datastorePath,
        repoDir: join(root, name),
        lockTimeoutMs: 30_000,
      });
      return {
        send,
        async stopSidecars() {
          for (const pid of await remember()) {
            hostLitestreamProcesses.signalGroup(pid, "SIGKILL");
          }
          const launched = await remember();
          await waitFor(
            () =>
              launched.every((pid) => !hostLitestreamProcesses.isAlive(pid)),
            "the machine's sidecars to stop",
          );
        },
        async crash() {
          await remember();
          alive = false;
          worker.terminate();
        },
      };
    },
    async lineages() {
      return await withMockedEnv({ [V3_REPLICA_ENV]: replica }, async () => {
        const root = `file:${replicaRoot}`;
        const read = await lineageRegistryFor(datastorePath).read(root);
        return {
          ...(currentLineage(read, root) !== undefined
            ? { current: currentLineage(read, root)!.fence }
            : {}),
          ...(newestStartedFence(read, root) !== undefined
            ? { newestStarted: newestStartedFence(read, root) }
            : {}),
        };
      });
    },
  };
  try {
    await fn(world);
  } finally {
    for (const { worker, pids: remember } of workers) {
      await remember().catch(() => {});
      worker.terminate();
    }
    // Every supervisor any machine launched, with its Litestream.
    for (const pid of pids) {
      hostLitestreamProcesses.signal(pid, "SIGCONT");
      hostLitestreamProcesses.signalGroup(pid, "SIGKILL");
    }
    await waitFor(
      () => [...pids].every((pid) => !hostLitestreamProcesses.isAlive(pid)),
      "every sidecar to stop",
    );
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

interface ReadResult {
  readonly commits: number;
  readonly restored: unknown;
}

async function read(machine: Machine): Promise<ReadResult> {
  return await machine.send({ kind: "read" }) as ReadResult;
}

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
      // The first writer writes again: it restores the takeover's lineage.
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
      // A short lease, then a commit its sidecar uploads, then a stall.
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
      // its lease check fails. It is told its changes may still appear,
      // not that nothing was committed.
      const closed = await assertRejects(() => a.send({ kind: "close" }));
      assertEquals((closed as MachineError).code, WRITER_FENCED_CODE);
      assertStringIncludes(
        (closed as MachineError).message,
        "They may still appear",
      );
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 3);
      assertEquals((await read(b)).commits, 3);
      // The zombie's own checkout: its copy is restored from the takeover's
      // lineage, where the commit at its read model's cursor is another
      // one, so the read model replays (ADV-7) and holds the acknowledged
      // records only.
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
      // The first machine takes the lease without writing, as a read-only
      // recovery does, on a copy that is behind.
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
    "v3 restore: serve's retake after another checkout wrote restores into its open store",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const serve = await world.machine("serve");
      await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
      await serve.send({ kind: "write", commits: 1, close: false });
      await serve.send({ kind: "upkeep", probeMs: 300 });
      // The probe publishes serve's passive commit.
      await waitFor(
        async () => (await world.lineages()).current !== undefined,
        "serve's head",
      );
      const paused = serve.send({ kind: "pause", ms: STALL_MS });
      const other = await world.machine("other");
      await other.send({ kind: "write", commits: 2, close: true });
      await paused;
      // Serve retakes the lease, restores the other writer's lineage into
      // its open store, and writes on top of it.
      await serve.send({ kind: "write", commits: 1, close: false });
      await serve.send({ kind: "stopUpkeep" });
      await serve.send({ kind: "close" });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 4);
    });
  },
});

Deno.test({
  name:
    "v3 restore: after serve's retake nothing commits or collects chunks on its copy until the restore lands",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const serve = await world.machine("serve");
      await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
      await serve.send({ kind: "write", commits: 1, close: false });
      await serve.send({ kind: "upkeep", probeMs: 300 });
      await waitFor(
        async () => (await world.lineages()).current !== undefined,
        "serve's head",
      );
      const paused = serve.send({ kind: "pause", ms: STALL_MS });
      const other = await world.machine("other");
      await other.send({ kind: "write", commits: 2, close: true });
      // Serve's restore after its retake waits on this lock.
      const lock = await Deno.open(
        await serve.send({ kind: "restoreLock" }) as string,
        { read: true, write: true, create: true },
      );
      await lock.lock(true);
      try {
        await paused;
        // Once serve retook the lease, a commit is still refused: its copy
        // is not current until the restore lands.
        // The lost lease's refusal names the fence that took over; the
        // retaken lease's, on a copy not yet current, names none.
        await waitFor(async () => {
          const refused = await serve.send({ kind: "tryCommit" });
          return typeof refused === "string" &&
            refused.includes("took over") && !refused.includes("(fence ");
        }, "a commit refused after the retake");
        const gc = await serve.send({ kind: "gc" }) as string | null;
        assert(gc !== null && gc.includes("made current"), `gc: ${gc}`);
      } finally {
        await lock.unlock();
        lock.close();
      }
      await waitFor(
        async () => await serve.send({ kind: "tryCommit" }) === null,
        "a commit once the restore landed",
      );
      await serve.send({ kind: "stopUpkeep" });
      await serve.send({ kind: "close" });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 4);
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
      // Two commands, fences 1 and 2, one lineage at fence 1.
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

const S3_ENDPOINT = Deno.env.get("SWAMP_TEST_LITESTREAM_S3_ENDPOINT");

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
