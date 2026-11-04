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
 * each machine is a worker with its own module state, host name and checkout on
 * one filesystem v3 datastore, so two checkouts behave like two machines on a
 * bucket
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  parseV3ReplicaSetting,
  replicaRootOf,
  V3_REPLICA_ENV,
} from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import {
  initializeV3Datastore,
  isFreshV3Skeleton,
  v3CommitsDbPath,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { lineageRegistryFor } from "../src/infrastructure/datastore_v3/litestream/v3_copy.ts";
import { V3_RESTORE_FAILED_CODE } from "../src/infrastructure/datastore_v3/litestream/litestream_restorer.ts";
import {
  currentLineage,
  newestStartedFence,
} from "../src/domain/datastore_v3/published_lineage.ts";
import { replicaPathFor } from "../src/domain/datastore_v3/replication_lineage.ts";
import { V3_REPLICATION_UNCONFIRMED_CODE } from "../src/domain/datastore_v3/litestream_replication.ts";
import { WRITER_FENCED_CODE } from "../src/domain/datastore_v3/writer_lease.ts";
import {
  killSidecarAtTeardown,
  SIDECAR_TESTS_IGNORED,
} from "./datastore_v3_litestream_helpers.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import type {
  MachineRequest,
  MachineResponse,
} from "./datastore_v3_litestream_machine_worker.ts";

const ignore = SIDECAR_TESTS_IGNORED;

const STALL_MS = 14_000;

interface Machine {
  send(request: MachineRequest): Promise<unknown>;
  crash(): Promise<void>;
  stopSidecars(): Promise<void>;
}

interface World {
  readonly root: string;
  readonly datastorePath: string;
  readonly replicaRoot: string;
  readonly replica: string;
  machine(
    name: string,
    options?: {
      readonly namespace?: string;
      readonly replica?: string;
      readonly checkout?: string;
      readonly gated?: boolean;
      readonly captureWarnings?: boolean;
      readonly lockTimeoutMs?: number;
      readonly binaryMissing?: boolean;
    },
  ): Promise<Machine>;
  lineages(): Promise<{ current?: number; newestStarted?: number }>;
  registered(fence: number): Promise<boolean>;
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
    async machine(name, machineOptions = {}) {
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
        replica: machineOptions.replica ?? replica,
        privateRoot,
        datastorePath,
        repoDir: join(root, machineOptions.checkout ?? name),
        lockTimeoutMs: machineOptions.lockTimeoutMs ?? 30_000,
        ...(machineOptions.namespace !== undefined
          ? { namespace: machineOptions.namespace }
          : {}),
        ...(machineOptions.gated === true ? { gated: true } : {}),
        ...(machineOptions.captureWarnings === true
          ? { captureWarnings: true }
          : {}),
        ...(machineOptions.binaryMissing === true
          ? { binaryMissing: true }
          : {}),
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
        const root = replicaRootOf(parseV3ReplicaSetting(replica));
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
    async registered(fence) {
      return await withMockedEnv(
        { [V3_REPLICA_ENV]: replica },
        async () =>
          typeof await lineageRegistryFor(datastorePath).started(fence) ===
            "object",
      );
    },
  };
  try {
    await fn(world);
  } finally {
    for (const { worker, pids: remember } of workers) {
      await remember().catch(() => {});
      worker.terminate();
    }
    for (const pid of pids) killSidecarAtTeardown(pid);
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
    "v3 restore: a reader restored behind another machine's lease replays through its read model, logs no outside reset and leaves its catalog current (swamp-club#4387)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a", { captureWarnings: true });
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "lease", ttlMs: 1_500 });
      await a.send({ kind: "write", commits: 1, close: false });
      await a.send({ kind: "catchUp" });
      const paused = a.send({ kind: "pause", ms: STALL_MS });
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true });
      await paused;
      await assertRejects(() => a.send({ kind: "close" }));
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 3);
      const acknowledged = await c.send({ kind: "files" }) as string[];
      await a.send({ kind: "warnings" });
      // the takeover holds the writer lease, so the zombie's restore cannot
      // recover under it and replays as a reader
      await b.send({ kind: "lease", ttlMs: 60_000 });
      assertEquals((await read(a)).commits, 3);
      const files = await a.send({ kind: "files" }) as string[];
      for (const file of acknowledged) {
        assert(files.includes(file), `${file} is applied after the restore`);
      }
      assertEquals(files.length, 4, "the reader leaves the zombie's file");
      assertEquals(await a.send({ kind: "readModel" }), {
        cursor: 3,
        populated: true,
      });
      const warnings = await a.send({ kind: "warnings" }) as string[];
      assertEquals(
        warnings.filter((w) => w.includes("outside the read model")),
        [],
      );
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
  name:
    "v3 restore: a serve write confirmed before it answers survives a crash and a takeover (swamp-club#3489)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "lease", ttlMs: 1_500 });
      await a.send({ kind: "write", commits: 1, close: false });
      await a.send({ kind: "confirm" });
      await a.crash();
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 4, "the acknowledged commit kept");
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
    "v3 restore: serve's retake after another checkout wrote restores into its open store",
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
      const fence = await serve.send({ kind: "fence" }) as number;
      const paused = serve.send({ kind: "pause", ms: STALL_MS });
      const other = await world.machine("other");
      await other.send({ kind: "write", commits: 2, close: true });
      await paused;
      // serve's renewal finds the lease lost and retakes it, restoring the
      // other lineage; a write started before the renewal noticed is refused,
      // as its copy is behind while serve holds its sidecar
      await waitFor(
        async () => (await serve.send({ kind: "fence" }) as number) > fence,
        "serve's retake",
      );
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
            refused.includes("took over") && !refused.includes("(fence ") &&
            refused.includes("still being brought up to date") &&
            !refused.includes("Another swamp process");
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
    "v3 restore: a seeding writer that fails before confirming leaves the shared commits for the next checkout's writer (swamp-club#3491)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const before = await world.machine("before", { replica: "" });
      await before.send({ kind: "write", commits: 3, close: true });
      // The first writer seeds its copy and claims its lineage, then dies
      // before its first sync is confirmed. Its short lease then expires.
      const first = await world.machine("first", { checkout: "before" });
      await first.send({ kind: "lease", ttlMs: 1_500 });
      await first.send({ kind: "write", commits: 1, close: false });
      await first.crash();
      const claimed = await world.lineages();
      assert(claimed.newestStarted !== undefined, "first claimed a lineage");
      assertEquals(claimed.current, undefined);
      const other = await world.machine("other");
      await other.send({ kind: "write", commits: 1, close: true });
      const fresh = await world.machine("fresh");
      assertEquals((await read(fresh)).commits, 4);
    });
  },
});

async function closeGate(world: World, name: string): Promise<void> {
  await Deno.writeTextFile(join(world.root, name), "");
}

async function gateEntered(world: World, name: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        await Deno.stat(join(world.root, `${name}.entered`));
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
    `${name} to be reached`,
    { timeoutMs: 60_000 },
  );
}

async function openGate(world: World, name: string): Promise<void> {
  await Deno.remove(join(world.root, name));
}

async function chmodTree(dir: string, mode: number): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) await chmodTree(join(dir, entry.name), mode);
  }
  await Deno.chmod(dir, mode);
}

/**
 * the stale restore must never be marked current nor start serve's lineage;
 * keepStale keeps it restorable on a file replica, where the other writer's
 * collection would remove it
 */
async function retakeDuringStaleRestore(
  world: World,
  options: { readonly keepStale: boolean },
): Promise<void> {
  const serve = await world.machine("serve", { gated: true });
  await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
  await serve.send({ kind: "write", commits: 1, close: false });
  await serve.send({ kind: "upkeep", probeMs: 300 });
  await waitFor(
    async () => (await world.lineages()).current !== undefined,
    "serve's head",
  );
  const first = await serve.send({ kind: "fence" }) as number;
  await closeGate(world, "machine-serve-gate-restore");
  const other = await world.machine("other");
  let paused = serve.send({ kind: "pause", ms: STALL_MS });
  await other.send({ kind: "write", commits: 2, close: true });
  const stale = (await world.lineages()).current!;
  let kept: string | undefined;
  if (options.keepStale) {
    // Its collection fails, as a best-effort removal may.
    kept = replicaPathFor(world.replicaRoot, stale);
    await chmodTree(kept, 0o555);
  }
  try {
    await paused;
    await waitFor(
      async () => (await serve.send({ kind: "fence" }) as number) > first,
      "serve's first retake",
    );
    const retaken = await serve.send({ kind: "fence" }) as number;
    await gateEntered(world, "machine-serve-gate-restore");
    paused = serve.send({ kind: "pause", ms: STALL_MS });
    await other.send({ kind: "write", commits: 1, close: true });
    await paused;
    await waitFor(
      async () => (await serve.send({ kind: "fence" }) as number) > retaken,
      "serve's second retake",
    );
    assert(await world.registered(stale), "the stale lineage is kept");
    assert((await world.lineages()).current! > stale);
    await openGate(world, "machine-serve-gate-restore");
    await waitFor(
      async () => await serve.send({ kind: "tryCommit" }) === null,
      "serve's commit on the current state",
      { timeoutMs: 30_000 },
    );
    await serve.send({ kind: "stopUpkeep" });
    await serve.send({ kind: "close" });
  } finally {
    if (kept !== undefined) await chmodTree(kept, 0o755);
  }
  const c = await world.machine("c");
  assertEquals((await read(c)).commits, 5);
}

async function retakeDuringSidecarStart(world: World): Promise<void> {
  const serve = await world.machine("serve", { gated: true });
  await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
  await serve.send({ kind: "write", commits: 1, close: false });
  await serve.send({ kind: "upkeep", probeMs: 300 });
  await waitFor(
    async () => (await world.lineages()).current !== undefined,
    "serve's head",
  );
  const first = await serve.send({ kind: "fence" }) as number;
  await closeGate(world, "machine-serve-gate-sidecar");
  for (const pid of await serve.send({ kind: "pids" }) as number[]) {
    hostLitestreamProcesses.signalGroup(pid, "SIGKILL");
  }
  await gateEntered(world, "machine-serve-gate-sidecar");
  const other = await world.machine("other");
  const paused = serve.send({ kind: "pause", ms: STALL_MS });
  await other.send({ kind: "write", commits: 2, close: true });
  await paused;
  await waitFor(
    async () => (await serve.send({ kind: "fence" }) as number) > first,
    "serve's retake",
  );
  await openGate(world, "machine-serve-gate-sidecar");
  await waitFor(
    async () => await serve.send({ kind: "tryCommit" }) === null,
    "serve's commit once the replacement settled",
    { timeoutMs: 30_000 },
  );
  await serve.send({ kind: "stopUpkeep" });
  await serve.send({ kind: "close" });
  const c = await world.machine("c");
  assertEquals((await read(c)).commits, 4);
}

Deno.test({
  name:
    "v3 restore: a retake while serve's replacement restores a stale lineage keeps every acknowledged commit (swamp-club#3565)",
  ignore,
  async fn() {
    await withMachines((world) =>
      retakeDuringStaleRestore(world, { keepStale: true })
    );
  },
});

Deno.test({
  name:
    "v3 restore: a retake while serve's replacement starts its sidecar leaves serve writing (swamp-club#3565)",
  ignore,
  async fn() {
    await withMachines(retakeDuringSidecarStart);
  },
});

function s3Replica(): string {
  return JSON.stringify({
    type: "s3",
    bucket: Deno.env.get("SWAMP_TEST_LITESTREAM_S3_BUCKET") ?? "swamp-test",
    path: `ls-${crypto.randomUUID()}`,
    endpoint: S3_ENDPOINT,
    region: "us-east-1",
  });
}

Deno.test({
  name:
    "v3 restore: on an S3 replica, a retake during a stale restore keeps every acknowledged commit (opt-in, swamp-club#3565)",
  ignore: ignore || S3_ENDPOINT === undefined,
  async fn() {
    await withMachines(
      (world) => retakeDuringStaleRestore(world, { keepStale: false }),
      { replica: s3Replica },
    );
  },
});

Deno.test({
  name:
    "v3 restore: on an S3 replica, a retake during a sidecar start leaves serve writing (opt-in, swamp-club#3565)",
  ignore: ignore || S3_ENDPOINT === undefined,
  async fn() {
    await withMachines(retakeDuringSidecarStart, { replica: s3Replica });
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

Deno.test({
  name:
    "v3 restore: a stale restore that dropped an applied commit still rebuilds serve's read model (swamp-club#3565)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const serve = await world.machine("serve", { gated: true });
      await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
      await serve.send({ kind: "write", commits: 1, close: false });
      await serve.send({ kind: "confirm" });
      await serve.send({ kind: "upkeep", probeMs: 60_000 });
      assertEquals(await serve.send({ kind: "tryCommit" }), null);
      await serve.send({ kind: "catchUp" });
      assertEquals((await serve.send({ kind: "files" }) as string[]).length, 2);
      await closeGate(world, "machine-serve-gate-restore");
      const other = await world.machine("other");
      const paused = serve.send({ kind: "pause", ms: STALL_MS });
      await other.send({ kind: "write", commits: 2, close: true });
      await paused;
      await gateEntered(world, "machine-serve-gate-restore");
      const retaken = await serve.send({ kind: "fence" }) as number;
      const planted = await plantV3WriterLease(world.datastorePath, {
        pid: Deno.ppid,
      });
      await planted.release();
      await waitFor(
        async () => (await serve.send({ kind: "fence" }) as number) > retaken,
        "serve's second retake",
      );
      await openGate(world, "machine-serve-gate-restore");
      await waitFor(
        async () => await serve.send({ kind: "tryCommit" }) === null,
        "serve's commit after the replacement",
        { timeoutMs: 30_000 },
      );
      await waitFor(
        () => serve.send({ kind: "confirm" }).then(() => true, () => false),
        "serve's commit confirmed",
      );
      await serve.send({ kind: "catchUp" });
      const files = await serve.send({ kind: "files" }) as string[];
      await serve.send({ kind: "stopUpkeep" });
      await serve.send({ kind: "close" });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 4);
      assertEquals(files, await c.send({ kind: "files" }));
    });
  },
});
