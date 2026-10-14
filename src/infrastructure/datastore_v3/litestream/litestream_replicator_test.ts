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
import {
  V3ReplicationError,
  V3ReplicationUnavailableError,
} from "../../../domain/datastore_v3/litestream_replication.ts";
import {
  type LitestreamControl,
  LitestreamControlError,
} from "./litestream_control_client.ts";
import {
  type LitestreamProcesses,
  SUPERVISOR_MARKER,
  type SupervisorLaunch,
} from "./litestream_processes.ts";
import {
  DEFAULT_REPLICATOR_TIMINGS,
  LitestreamReplicator,
  type ReplicatorDeps,
} from "./litestream_replicator.ts";
import {
  ensureSharedDir,
  isMarkedForReplacement,
  type ReplicationPaths,
  replicationPathsFor,
  writePresence,
} from "./replication_files.ts";
import { parseSupervisorArgs } from "./replication_supervisor.ts";

const UNIX = Deno.build.os !== "windows";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // Under /tmp: macOS TMPDIR is too long for a socket path.
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-ls-rep-" });
  try {
    await fn(await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

interface FakeSidecar {
  readonly supervisorPid: number;
  readonly litestreamPid: number;
  readonly lineageFence: number;
  readonly lock: Deno.FsFile;
  alive: boolean;
  frozen: boolean;
}

/**
 * Supervisors as fakes over the real lock files: a launch takes
 * supervisor.lock and writes presence.json as a real supervisor would.
 */
class FakeWorld {
  time = Date.now();
  nextPid = 50_000;
  readonly sidecars: FakeSidecar[] = [];
  readonly killed: number[] = [];
  readonly commandLines = new Map<number, string>();
  readonly starting: Promise<void>[] = [];
  syncAnswer: () => Promise<Record<string, unknown>> = () =>
    Promise.resolve({ status: "synced", txid: 2, replicated_txid: 2 });
  leaseCurrent = true;
  leaseChecks = 0;

  constructor(readonly paths: ReplicationPaths) {}

  get live(): FakeSidecar[] {
    return this.sidecars.filter((s) => s.alive);
  }

  readonly processes: LitestreamProcesses = {
    launch: (launch: SupervisorLaunch) => {
      const options = parseSupervisorArgs(launch.args)!;
      const supervisorPid = this.nextPid++;
      const litestreamPid = this.nextPid++;
      this.commandLines.set(supervisorPid, `swamp ${launch.args.join(" ")}`);
      this.commandLines.set(
        litestreamPid,
        `litestream replicate -config ${this.paths.config} -no-expand-env`,
      );
      const lock = Deno.openSync(this.paths.supervisorLock, {
        read: true,
        write: true,
      });
      const sidecar: FakeSidecar = {
        supervisorPid,
        litestreamPid,
        lineageFence: options.lineageFence,
        lock,
        alive: true,
        frozen: false,
      };
      this.sidecars.push(sidecar);
      // Like a real supervisor: retry the lock the command's probe may still
      // hold, then record itself.
      this.starting.push((async () => {
        while (!await lock.tryLock(true)) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        await Deno.writeTextFile(
          this.paths.presence,
          JSON.stringify({
            supervisorPid,
            litestreamPid,
            uid: Deno.uid(),
            hostname: Deno.hostname(),
            lineageFence: options.lineageFence,
            replicaPath: options.replicaPath,
          }),
        );
      })());
      return supervisorPid;
    },
    commandLine: (pid) => Promise.resolve(this.commandLines.get(pid)),
    isAlive: (pid) =>
      this.commandLines.has(pid) &&
      !this.sidecars.some((s) =>
        !s.alive && (s.supervisorPid === pid || s.litestreamPid === pid)
      ),
    signal: (pid) => {
      this.killed.push(pid);
    },
    signalGroup: (pgid) => {
      this.killed.push(-pgid);
      for (const sidecar of this.sidecars) {
        if (sidecar.supervisorPid === pgid && sidecar.alive) {
          sidecar.alive = false;
          sidecar.lock.close();
          this.commandLines.delete(sidecar.supervisorPid);
          this.commandLines.delete(sidecar.litestreamPid);
        }
      }
    },
  };

  readonly control: LitestreamControl = {
    info: () => {
      const sidecar = this.live.at(-1);
      if (sidecar === undefined) {
        return Promise.reject(new LitestreamControlError("no socket", false));
      }
      if (sidecar.frozen) {
        return Promise.reject(new LitestreamControlError("no answer", true));
      }
      return Promise.resolve({ pid: sidecar.litestreamPid });
    },
    sync: () => this.syncAnswer() as never,
  };

  deps(over: Partial<ReplicatorDeps> = {}): ReplicatorDeps {
    return {
      processes: this.processes,
      control: this.control,
      resolveBinary: () => Promise.resolve("/bin/litestream"),
      supervisor: { command: "swamp", prefixArgs: [] },
      timings: {
        ...DEFAULT_REPLICATOR_TIMINGS,
        lockWaitMs: 300,
        startWaitMs: 300,
      },
      now: () => this.time,
      sleep: async (ms) => {
        this.time += ms;
        // Lets a launched fake supervisor take its lock.
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
      privateRoot: join(dirname(this.paths.privateDir)),
      ...over,
    };
  }

  /** A request for `db` at `fence`, checking the world's lease. */
  request(db: string, fence: number) {
    return {
      commitsDb: db,
      replica: FILE,
      fence,
      assertLeaseCurrent: () => {
        this.leaseChecks++;
        return this.leaseCurrent
          ? Promise.resolve()
          : Promise.reject(new Error("fenced"));
      },
    };
  }

  close(): void {
    for (const sidecar of this.live) sidecar.lock.close();
  }
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

async function withWorld(
  fn: (world: FakeWorld, db: string) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "ds"));
    const db = join(dir, "ds", "commits.db");
    await Deno.writeTextFile(db, "");
    const paths = await replicationPathsFor(db, join(dir, "priv"));
    await ensureSharedDir(paths);
    const world = new FakeWorld(paths);
    try {
      await fn(world, db);
    } finally {
      world.close();
    }
  });
}

const FILE = { type: "file", path: "/replica" } as const;

Deno.test({
  name:
    "LitestreamReplicator.acquire: starts a sidecar when none runs, then reuses it",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      const first = await replicator.acquire(world.request(db, 1));
      await first.sync(5_000);
      await first.release();
      const second = await replicator.acquire(world.request(db, 2));
      await second.release();
      assertEquals(world.sidecars.length, 1);
      assertEquals(world.killed, []);
      assertEquals(
        second.lineageFence,
        1,
        "the next fence continues the lineage",
      );
    });
  },
});

Deno.test({
  name: "LitestreamReplicator.acquire: holds in one process share one sidecar",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      const a = await replicator.acquire(world.request(db, 1));
      const b = await replicator.acquire(world.request(db, 1));
      assertEquals(world.sidecars.length, 1);
      await a.release();
      await a.release();
      // Still held by b: another process could not take it exclusively.
      const probe = await Deno.open(world.paths.useLock, {
        read: true,
        write: true,
      });
      try {
        assertEquals(await probe.tryLock(true), false);
      } finally {
        probe.close();
      }
      await b.release();
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator.acquire: replaces a frozen sidecar after the wait, leaving one",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      await (await replicator.acquire(world.request(db, 1))).release();
      world.sidecars[0].frozen = true;
      const handle = await replicator.acquire(world.request(db, 2));
      await handle.release();
      assertEquals(world.sidecars.length, 2);
      assertEquals(world.live.length, 1);
      assertEquals(
        world.killed.includes(-world.sidecars[0].supervisorPid),
        true,
      );
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator.acquire: another writer's fence in between replaces the sidecar's lineage",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      await (await replicator.acquire(world.request(db, 1))).release();
      const handle = await replicator.acquire(world.request(db, 5));
      await handle.release();
      assertEquals(handle.lineageFence, 5);
      assertEquals(world.live.map((s) => s.lineageFence), [5]);
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator: a definite sync failure condemns the sidecar, a timeout does not",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      world.syncAnswer = () =>
        Promise.reject(new LitestreamControlError("slow", true));
      let handle = await replicator.acquire(world.request(db, 1));
      await assertRejects(
        () => handle.sync(5_000),
        V3ReplicationError,
        "did not finish",
      );
      await handle.release();
      assertEquals(
        await isMarkedForReplacement(
          world.paths,
          world.sidecars[0].supervisorPid,
        ),
        false,
      );
      handle = await replicator.acquire(world.request(db, 2));
      assertEquals(world.sidecars.length, 1, "a timed-out sidecar is reused");

      world.syncAnswer = () =>
        Promise.reject(
          new LitestreamControlError("POST /sync answered 500", false),
        );
      await assertRejects(
        () => handle.sync(5_000),
        V3ReplicationError,
        "answered 500",
      );
      await handle.release();
      assert(
        await isMarkedForReplacement(
          world.paths,
          world.sidecars[0].supervisorPid,
        ),
      );
      world.syncAnswer = () =>
        Promise.resolve({ status: "synced", txid: 3, replicated_txid: 3 });
      await (await replicator.acquire(world.request(db, 3))).release();
      assertEquals(world.live.length, 1);
      assertEquals(world.sidecars.length, 2, "a condemned sidecar is replaced");
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator: a sync that does not reach the local txid confirms nothing",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      world.syncAnswer = () =>
        Promise.resolve({ status: "synced", txid: 4, replicated_txid: 3 });
      const handle = await replicator.acquire(world.request(db, 1));
      await assertRejects(() => handle.sync(5_000), V3ReplicationError);
      assertEquals(world.leaseChecks, 0);
      await handle.release();
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator: a confirmed sync still fails when the lease was taken over",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      const handle = await replicator.acquire(world.request(db, 1));
      world.leaseCurrent = false;
      // A lost lease fails the command like any unconfirmed sync.
      await assertRejects(
        () => handle.sync(5_000),
        V3ReplicationError,
        "lost its writer lease",
      );
      assertEquals(world.leaseChecks, 1);
      await handle.release();
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator: a stale record naming an unrelated live pid is never killed",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      world.commandLines.set(777, "vim notes.txt");
      world.commandLines.set(778, "bash");
      await writePresence(world.paths, {
        supervisorPid: 777,
        litestreamPid: 778,
        uid: Deno.uid(),
        hostname: Deno.hostname(),
        lineageFence: 1,
        replicaPath: "/replica/_litestream/000000000001",
      });
      const replicator = new LitestreamReplicator(world.deps());
      await (await replicator.acquire(world.request(db, 1))).release();
      assertEquals(world.killed, []);
      assertEquals(world.live.length, 1);
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator: a lock held by a process it cannot verify is waited for, then refused",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      world.commandLines.set(777, "vim notes.txt");
      await writePresence(world.paths, {
        supervisorPid: 777,
        uid: Deno.uid(),
        hostname: Deno.hostname(),
        lineageFence: 1,
        replicaPath: "/replica/_litestream/000000000001",
      });
      const holder = await Deno.open(world.paths.supervisorLock, {
        read: true,
        write: true,
        create: true,
      });
      try {
        await holder.lock(true);
        const replicator = new LitestreamReplicator(world.deps());
        await assertRejects(
          () => replicator.acquire(world.request(db, 1)),
          V3ReplicationUnavailableError,
          "cannot verify",
        );
        assertEquals(world.killed, []);
        assertEquals(world.sidecars.length, 0);
      } finally {
        holder.close();
      }
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator: another host's sidecar is refused, never touched",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      world.commandLines.set(
        777,
        `swamp ${SUPERVISOR_MARKER} --db ${world.paths.commitsDb}`,
      );
      await writePresence(world.paths, {
        supervisorPid: 777,
        uid: Deno.uid(),
        hostname: "another-host",
        lineageFence: 1,
        replicaPath: "/replica/_litestream/000000000001",
      });
      const holder = await Deno.open(world.paths.supervisorLock, {
        read: true,
        write: true,
        create: true,
      });
      try {
        await holder.lock(true);
        const replicator = new LitestreamReplicator(world.deps());
        await assertRejects(
          () => replicator.acquire(world.request(db, 1)),
          V3ReplicationUnavailableError,
          "another user or host",
        );
        assertEquals(world.killed, []);
      } finally {
        holder.close();
      }
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator: a supervisor that died leaves its Litestream to be killed before a start",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      await (await replicator.acquire(world.request(db, 1))).release();
      const old = world.sidecars[0];
      // The supervisor is gone; its Litestream lives on.
      old.alive = false;
      old.lock.close();
      world.commandLines.delete(old.supervisorPid);
      old.alive = false;
      const isAlive = world.processes.isAlive;
      world.processes.isAlive = (pid) =>
        pid === old.litestreamPid || isAlive(pid);
      await (await replicator.acquire(world.request(db, 2))).release();
      assert(world.killed.includes(old.litestreamPid));
      assertEquals(world.live.length, 1);
    });
  },
});

Deno.test({
  name: "LitestreamReplicator: a failed acquire records no use of the sidecar",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      await (await replicator.acquire(world.request(db, 1))).release();
      const before = (await Deno.stat(world.paths.useLock)).mtime?.getTime();
      world.sidecars[0].frozen = true;
      // Another command holds it, so the frozen sidecar cannot be replaced.
      const other = await Deno.open(world.paths.useLock, {
        read: true,
        write: true,
      });
      try {
        await other.lock(false);
        world.time += 60_000;
        await assertRejects(
          () => replicator.acquire(world.request(db, 2)),
          V3ReplicationUnavailableError,
        );
      } finally {
        other.close();
      }
      assertEquals(
        (await Deno.stat(world.paths.useLock)).mtime?.getTime(),
        before,
      );
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator.acquire: concurrent acquires in one process share one sidecar and one hold",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const replicator = new LitestreamReplicator(world.deps());
      const [a, b] = await Promise.all([
        replicator.acquire(world.request(db, 1)),
        replicator.acquire(world.request(db, 1)),
      ]);
      assertEquals(world.sidecars.length, 1);
      await a.release();
      const probe = await Deno.open(world.paths.useLock, {
        read: true,
        write: true,
      });
      try {
        assertEquals(await probe.tryLock(true), false, "b still holds it");
      } finally {
        probe.close();
      }
      await b.release();
      const after = await Deno.open(world.paths.useLock, {
        read: true,
        write: true,
      });
      try {
        assertEquals(await after.tryLock(true), true, "no hold leaked");
      } finally {
        after.close();
      }
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator: a replacement kills nothing when the record changed while it waited",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      const setupReplicator = new LitestreamReplicator(world.deps());
      await (await setupReplicator.acquire(world.request(db, 1))).release();
      const first = world.sidecars[0];
      first.frozen = true;
      // Another command holds the sidecar, so this one's replacement waits
      // for the use lock.
      const other = await Deno.open(world.paths.useLock, {
        read: true,
        write: true,
      });
      await other.lock(false);
      const started = world.time;
      let swapped = false;
      const base = world.deps();
      const replicator = new LitestreamReplicator({
        ...base,
        async sleep(ms) {
          await base.sleep(ms);
          // Past the start wait, the replacement is waiting for the lock:
          // the other command replaces the sidecar and lets go.
          if (!swapped && world.time - started > 350) {
            swapped = true;
            world.processes.signalGroup(first.supervisorPid, "SIGKILL");
            world.processes.launch({
              command: "swamp",
              args: [
                "__swamp_v3_replication_supervisor",
                "--db",
                world.paths.commitsDb,
                "--private-root",
                "/p",
                "--lineage",
                "1",
                "--replica-path",
                "/replica/_litestream/000000000001",
                "--idle-ms",
                "1",
                "--stop-wait-ms",
                "1",
                "--tick-ms",
                "1",
              ],
              cwd: "/",
            });
            await Promise.all(world.starting);
            world.killed.length = 0;
            other.close();
          }
        },
      });
      try {
        await (await replicator.acquire(world.request(db, 2))).release();
      } finally {
        if (!swapped) other.close();
      }
      assert(swapped);
      assertEquals(
        world.killed.filter((pid) => pid < 0),
        [],
        "the newer supervisor was not killed",
      );
      assertEquals(world.live.length, 1);
    });
  },
});

Deno.test({
  name:
    "LitestreamReplicator: a failed launch releases its lock probe, so the next acquire starts a sidecar",
  ignore: !UNIX,
  async fn() {
    await withWorld(async (world, db) => {
      let failures = 1;
      const replicator = new LitestreamReplicator({
        ...world.deps(),
        resolveBinary: () =>
          failures-- > 0
            ? Promise.reject(new Error("download failed"))
            : Promise.resolve("/bin/litestream"),
      });
      await assertRejects(
        () => replicator.acquire(world.request(db, 1)),
        Error,
        "download failed",
      );
      const probe = await Deno.open(world.paths.supervisorLock, {
        read: true,
        write: true,
      });
      try {
        assertEquals(await probe.tryLock(true), true, "no lock left held");
      } finally {
        probe.close();
      }
      await (await replicator.acquire(world.request(db, 1))).release();
      assertEquals(world.live.length, 1);
    });
  },
});
