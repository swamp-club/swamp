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
  type LitestreamChild,
  parseSupervisorArgs,
  runReplicationSupervisor,
  supervisorArgs,
  type SupervisorDeps,
  type SupervisorOptions,
  touchUseLock,
} from "./replication_supervisor.ts";
import {
  ensureSharedDir,
  readPresence,
  type ReplicationPaths,
  replicationPathsFor,
} from "./replication_files.ts";

const UNIX = Deno.build.os !== "windows";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // Under /tmp: macOS TMPDIR is too long for a socket path.
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-ls-sup-" });
  try {
    await fn(await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A Litestream child that exits on the signals it honours. */
class FakeChild implements LitestreamChild {
  readonly pid = 4242;
  readonly signals: Deno.Signal[] = [];
  readonly exited: Promise<void>;
  #exit!: () => void;
  constructor(private readonly honours: readonly Deno.Signal[]) {
    this.exited = new Promise((resolve) => this.#exit = resolve);
  }
  kill(signal: Deno.Signal): void {
    this.signals.push(signal);
    if (this.honours.includes(signal)) this.#exit();
  }
  exit(): void {
    this.#exit();
  }
}

interface Harness {
  readonly deps: SupervisorDeps;
  readonly child: FakeChild;
  /** Fake time, advanced by every sleep. */
  now(): number;
  /** Runs `fn` once fake time reaches `atMs` past the start. */
  at(atMs: number, fn: () => Promise<void> | void): void;
  started: boolean;
}

function harness(
  honours: readonly Deno.Signal[] = ["SIGTERM", "SIGKILL"],
): Harness {
  let time = Date.now();
  const start = time;
  const pending: { atMs: number; fn: () => Promise<void> | void }[] = [];
  const child = new FakeChild(honours);
  const h: Harness = {
    child,
    started: false,
    now: () => time,
    at(atMs, fn) {
      pending.push({ atMs, fn });
    },
    deps: {
      resolveBinary: () => Promise.resolve("/bin/litestream"),
      startLitestream: () => {
        h.started = true;
        return child;
      },
      now: () => time,
      async sleep(ms) {
        time += ms;
        for (const due of pending.filter((p) => start + p.atMs <= time)) {
          pending.splice(pending.indexOf(due), 1);
          await due.fn();
        }
        // Lets the fake child's exit settle.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    },
  };
  return h;
}

async function setup(dir: string): Promise<{
  options: SupervisorOptions;
  paths: ReplicationPaths;
}> {
  await Deno.mkdir(join(dir, "ds"));
  const db = join(dir, "ds", "commits.db");
  await Deno.writeTextFile(db, "");
  const options: SupervisorOptions = {
    commitsDb: db,
    privateRoot: join(dir, "priv"),
    lineageFence: 3,
    replicaPath: "/r/_litestream/000000000003",
    idleMs: 1_000,
    stopWaitMs: 500,
    tickMs: 100,
  };
  const paths = await replicationPathsFor(db, options.privateRoot);
  await ensureSharedDir(paths);
  return { options, paths };
}

Deno.test("parseSupervisorArgs: reads back what supervisorArgs writes, and nothing else", () => {
  const options: SupervisorOptions = {
    commitsDb: "/d/commits.db",
    privateRoot: "/tmp/swamp-1",
    lineageFence: 7,
    replicaPath: "/r/_litestream/000000000007",
    idleMs: 300_000,
    stopWaitMs: 5_000,
    tickMs: 2_000,
  };
  assertEquals(parseSupervisorArgs(supervisorArgs(options)), options);
  assertEquals(parseSupervisorArgs(["model", "run"]), undefined);
  const args = supervisorArgs(options);
  args[args.indexOf("--idle-ms") + 1] = "soon";
  assertEquals(parseSupervisorArgs(args), undefined);
});

Deno.test({
  name:
    "runReplicationSupervisor: records itself and its Litestream, then idles out and cleans up",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options, paths } = await setup(dir);
      const h = harness();
      let seen: Awaited<ReturnType<typeof readPresence>> | undefined;
      h.at(200, async () => {
        seen = await readPresence(paths);
      });
      assertEquals(await runReplicationSupervisor(options, h.deps), "idle");
      assertEquals(seen?.kind, "found");
      if (seen?.kind === "found") {
        assertEquals(seen.record.supervisorPid, Deno.pid);
        assertEquals(seen.record.litestreamPid, 4242);
        assertEquals(seen.record.lineageFence, 3);
      }
      assertEquals(h.child.signals, ["SIGTERM"]);
      assertEquals(await readPresence(paths), { kind: "missing" });
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: never stops while a command holds the use lock",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options, paths } = await setup(dir);
      const h = harness();
      let use: Deno.FsFile | undefined;
      let stoppedWhileHeld = false;
      h.at(500, async () => {
        use = await Deno.open(paths.useLock, { read: true, write: true });
        await use.lock(false);
      });
      h.at(3_000, async () => {
        stoppedWhileHeld = h.child.signals.length > 0;
        await touchUseLock(paths, h.now());
        use!.close();
      });
      const started = h.now();
      assertEquals(await runReplicationSupervisor(options, h.deps), "idle");
      assertEquals(stoppedWhileHeld, false);
      // It stopped a whole idle timeout after the command released it.
      assert(h.now() - started >= 3_000 + options.idleMs);
    });
  },
});

Deno.test({
  name: "runReplicationSupervisor: gives way to a supervisor that already runs",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options, paths } = await setup(dir);
      const other = await Deno.open(paths.supervisorLock, {
        read: true,
        write: true,
        create: true,
      });
      try {
        await other.lock(true);
        const h = harness();
        assertEquals(
          await runReplicationSupervisor(options, h.deps),
          "another-supervisor",
        );
        assertEquals(h.started, false);
      } finally {
        other.close();
      }
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: a command's momentary lock probe does not make it give up",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options, paths } = await setup(dir);
      const probe = await Deno.open(paths.supervisorLock, {
        read: true,
        write: true,
        create: true,
      });
      await probe.lock(true);
      const h = harness();
      // The probe lets go 200 ms into the supervisor's retries.
      h.at(200, () => probe.close());
      assertEquals(await runReplicationSupervisor(options, h.deps), "idle");
      assert(h.started);
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: kills a Litestream that ignores SIGTERM after the stop wait",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options } = await setup(dir);
      const h = harness(["SIGKILL"]);
      assertEquals(await runReplicationSupervisor(options, h.deps), "idle");
      assertEquals(h.child.signals, ["SIGTERM", "SIGKILL"]);
    });
  },
});

Deno.test({
  name: "runReplicationSupervisor: ends with Litestream, and cleans up",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options, paths } = await setup(dir);
      const h = harness();
      h.at(300, () => h.child.exit());
      assertEquals(
        await runReplicationSupervisor(options, h.deps),
        "litestream-exited",
      );
      assertEquals(await readPresence(paths), { kind: "missing" });
    });
  },
});

Deno.test({
  name: "runReplicationSupervisor: stops Litestream when asked to stop",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options } = await setup(dir);
      const h = harness();
      let request!: () => void;
      const stop = new Promise<void>((resolve) => request = resolve);
      h.at(300, () => request());
      assertEquals(
        await runReplicationSupervisor(options, {
          ...h.deps,
          stopRequested: stop,
        }),
        "stop-requested",
      );
      assertEquals(h.child.signals, ["SIGTERM"]);
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: a binary that cannot be had leaves no record behind",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options, paths } = await setup(dir);
      const h = harness();
      await assertRejects(
        () =>
          runReplicationSupervisor(options, {
            ...h.deps,
            resolveBinary: () => Promise.reject(new Error("offline")),
          }),
        Error,
        "offline",
      );
      assertEquals(await readPresence(paths), { kind: "missing" });
      assertEquals(h.started, false);
    });
  },
});
