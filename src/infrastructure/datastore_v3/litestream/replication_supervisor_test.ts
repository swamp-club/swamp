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
  type SupervisorVerifyRequest,
  touchUseLock,
} from "./replication_supervisor.ts";
import {
  ensureSharedDir,
  readCopyState,
  readPresence,
  type ReplicationPaths,
  replicationPathsFor,
  writeCopyState,
  writeReplicaVerification,
} from "./replication_files.ts";
import { REPLICA_VERIFY_BACKSTOP_MS } from "../../../domain/datastore_v3/replica_verification.ts";

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
  startMs: number = Date.now(),
): Harness {
  let time = startMs;
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

Deno.test("parseSupervisorArgs: reads back the replica check's interval (swamp-club#3935)", () => {
  const options: SupervisorOptions = {
    commitsDb: "/d/commits.db",
    privateRoot: "/tmp/swamp-1",
    lineageFence: 7,
    replicaPath: "/r/_litestream/000000000007",
    replicaType: "s3",
    idleMs: 300_000,
    stopWaitMs: 5_000,
    tickMs: 2_000,
    verifyIntervalMs: 60_000,
  };
  assertEquals(parseSupervisorArgs(supervisorArgs(options)), options);
});

/** A sidecar whose copy acknowledged `txid` on lineage 3, with a fake check. */
async function verifySetup(dir: string, txid = "0000000000000005") {
  const { options, paths } = await setup(dir);
  await writeCopyState(paths, {
    replicaRoot: "file:/r",
    lineageFence: 3,
    txid,
  });
  return {
    options: { ...options, replicaType: "file" as const },
    paths,
  };
}

Deno.test({
  name:
    "runReplicationSupervisor: checks its replica once the writer acknowledged a TXID, then idles out",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options } = await verifySetup(dir);
      const calls: SupervisorVerifyRequest[] = [];
      const h = harness();
      h.deps.verifyReplica = (request) => {
        calls.push(request);
        return Promise.resolve(undefined);
      };
      assertEquals(await runReplicationSupervisor(options, h.deps), "idle");
      // Once when it started, and not again at the idle exit: that TXID was
      // tried, and no new one was acknowledged.
      assertEquals(calls.length, 1);
      assertEquals(calls[0].lineageFence, 3);
      assertEquals(calls[0].replicaType, "file");
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: a TXID a verdict covers is not checked again",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options, paths } = await verifySetup(dir);
      const calls: SupervisorVerifyRequest[] = [];
      await writeReplicaVerification(paths, {
        lineageFence: 3,
        txid: "0000000000000005",
        checkedAt: new Date().toISOString(),
        ok: true,
      });
      const h = harness();
      h.deps.verifyReplica = (request) => {
        calls.push(request);
        return Promise.resolve(undefined);
      };
      assertEquals(await runReplicationSupervisor(options, h.deps), "idle");
      assertEquals(calls.length, 0);
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: an idle sidecar waits for a running check before it stops",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options } = await verifySetup(dir);
      const h = harness();
      let finish!: () => void;
      h.deps.verifyReplica = () =>
        new Promise<void>((resolve) => finish = resolve);
      let stoppedDuringCheck = false;
      h.at(3_000, () => {
        stoppedDuringCheck = h.child.signals.length > 0;
        finish();
      });
      const started = h.now();
      assertEquals(await runReplicationSupervisor(options, h.deps), "idle");
      assertEquals(stoppedDuringCheck, false);
      assert(h.now() - started >= 3_000);
    });
  },
});

Deno.test({
  name: "runReplicationSupervisor: a stop request cancels a running check",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options } = await verifySetup(dir);
      const h = harness();
      let stop!: () => void;
      h.deps.stopRequested = new Promise((resolve) => stop = resolve);
      let signal: AbortSignal | undefined;
      h.deps.verifyReplica = (request) => {
        signal = request.signal;
        return new Promise((_, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
          )
        );
      };
      h.at(500, () => stop());
      assertEquals(
        await runReplicationSupervisor(options, h.deps),
        "stop-requested",
      );
      assertEquals(signal?.aborted, true);
    });
  },
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const txidOf = (n: number) => n.toString(16).padStart(16, "0");

/**
 * A fake check that records a passing verdict at the harness's time, the
 * way the real one does, and counts the restores it stands for.
 */
function recordingVerify(
  h: Harness,
  paths: ReplicationPaths,
  calls: SupervisorVerifyRequest[],
): SupervisorDeps["verifyReplica"] {
  return async (request) => {
    calls.push(request);
    const copy = await readCopyState(paths);
    await writeReplicaVerification(paths, {
      lineageFence: request.lineageFence,
      txid: copy!.txid,
      checkedAt: new Date(h.now()).toISOString(),
      ok: true,
      ...(request.snapshotTxid !== undefined
        ? { snapshotTxid: request.snapshotTxid }
        : {}),
    });
  };
}

/**
 * A serve-shaped sidecar (swamp-club#4261): never idle, its writer
 * acknowledging a new TXID every minute for `hours`, then asked to stop.
 * `snapshotAt` gives the replica's newest snapshot at a time past the start.
 * Resolves with the restores and snapshot listings it ran.
 */
async function serveDay(
  dir: string,
  hours: number,
  snapshotAt: (elapsedMs: number) => string | undefined,
): Promise<{ restores: SupervisorVerifyRequest[]; polls: number }> {
  const { options, paths } = await verifySetup(dir, txidOf(1));
  const h = harness();
  const start = h.now();
  const restores: SupervisorVerifyRequest[] = [];
  let polls = 0;
  h.deps.verifyReplica = recordingVerify(h, paths, restores);
  h.deps.readSnapshotTxid = () => {
    polls++;
    return Promise.resolve(snapshotAt(h.now() - start));
  };
  let stop!: () => void;
  h.deps.stopRequested = new Promise((resolve) => stop = resolve);
  for (let m = 1; m < hours * 60; m++) {
    h.at(m * MINUTE, () =>
      writeCopyState(paths, {
        replicaRoot: "file:/r",
        lineageFence: 3,
        txid: txidOf(1 + m),
      }));
  }
  h.at(hours * HOUR, () => stop());
  assertEquals(
    await runReplicationSupervisor(
      { ...options, tickMs: MINUTE, idleMs: 100 * HOUR },
      h.deps,
    ),
    "stop-requested",
  );
  return { restores, polls };
}

Deno.test({
  name:
    "runReplicationSupervisor: a serve that writes all day restores once for its lineage and then once per backstop, not on a timer (swamp-club#4261)",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { restores, polls } = await serveDay(dir, 12, () => txidOf(1));
      // The new lineage, then the 4-hour backstop at hours 4 and 8; the
      // stop comes before hour 12's. A 10-minute timer ran 72.
      assertEquals(restores.length, 3);
      // One listing per 15 minutes at most, and none more.
      assert(polls <= 12 * 4 + 1, `${polls} listings`);
      assertEquals(restores[0].snapshotTxid, txidOf(1));
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: a new snapshot is checked before the backstop (swamp-club#4261)",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { restores } = await serveDay(
        dir,
        3,
        (elapsed) => elapsed < HOUR ? txidOf(1) : txidOf(50),
      );
      // The new lineage, then the snapshot written at hour 1.
      assertEquals(restores.length, 2);
      assertEquals(restores[1].snapshotTxid, txidOf(50));
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: a replica whose snapshots cannot be listed is still checked at the backstop (swamp-club#4261)",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { restores } = await serveDay(dir, 9, () => undefined);
      // The new lineage, then hours 4 and 8.
      assertEquals(restores.length, 3);
      assertEquals(restores[0].snapshotTxid, undefined);
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: a covered lineage lists nothing and restores nothing (swamp-club#4261)",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options, paths } = await verifySetup(dir);
      await writeReplicaVerification(paths, {
        lineageFence: 3,
        txid: "0000000000000005",
        checkedAt: new Date().toISOString(),
        ok: true,
      });
      const h = harness();
      let polls = 0;
      const restores: SupervisorVerifyRequest[] = [];
      h.deps.verifyReplica = recordingVerify(h, paths, restores);
      h.deps.readSnapshotTxid = () => {
        polls++;
        return Promise.resolve(txidOf(9));
      };
      assertEquals(await runReplicationSupervisor(options, h.deps), "idle");
      assertEquals(polls, 0);
      assertEquals(restores.length, 0);
    });
  },
});

Deno.test({
  name:
    "runReplicationSupervisor: a working day of CLI sidecars that each idle out after 5 minutes restores per trigger, not per exit (swamp-club#4261)",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const { options, paths } = await verifySetup(dir, txidOf(1));
      const restores: SupervisorVerifyRequest[] = [];
      let polls = 0;
      let time = Date.now();
      const dayStart = time;
      let sidecars = 0;
      let txid = 1;
      // Each command acknowledges a new TXID, then its sidecar idles out.
      while (time - dayStart < 8 * HOUR) {
        await writeCopyState(paths, {
          replicaRoot: "file:/r",
          lineageFence: 3,
          txid: txidOf(++txid),
        });
        const h = harness(["SIGTERM", "SIGKILL"], time);
        h.deps.verifyReplica = recordingVerify(h, paths, restores);
        h.deps.readSnapshotTxid = () => {
          polls++;
          return Promise.resolve(txidOf(1));
        };
        assertEquals(
          await runReplicationSupervisor(
            { ...options, tickMs: 10_000, idleMs: 5 * MINUTE },
            h.deps,
          ),
          "idle",
        );
        sidecars++;
        // The next command a minute after this sidecar stopped.
        time = h.now() + MINUTE;
      }
      assert(sidecars >= 60, `${sidecars} sidecars`);
      // The new lineage and the backstop at hours 4 and 8 at most, against
      // one restore per idle exit before swamp-club#4261.
      assert(
        restores.length <= 1 + Math.ceil(8 * HOUR / REPLICA_VERIFY_BACKSTOP_MS),
        `${restores.length} restores over ${sidecars} sidecars`,
      );
      assert(restores.length >= 2);
      // A listing per sidecar at most: once when it first sees something
      // uncovered, once when it goes idle.
      assert(polls <= 2 * sidecars, `${polls} listings`);
    });
  },
});
