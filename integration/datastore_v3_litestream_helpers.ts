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
 * needs the pinned Litestream at `SWAMP_LITESTREAM_PATH`, which verify-build
 * fetches; without it, or on Windows, the tests are ignored
 */

import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { waitFor } from "@swamp-club/swamp-testing";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  initializeV3Datastore,
  v3CommitsDbPath,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  setV3ReplicationForTesting,
} from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import {
  DEFAULT_REPLICATOR_TIMINGS,
  type ReplicatorDeps,
  type ReplicatorTimings,
} from "../src/infrastructure/datastore_v3/litestream/litestream_replicator.ts";
import {
  type PresenceRecord,
  readCopyState,
  readPresence,
  readReplicaVerification,
  type ReplicationPaths,
  replicationPathsFor,
  writeReplicaVerification,
} from "../src/infrastructure/datastore_v3/litestream/replication_files.ts";
import { normalizeTxid } from "../src/domain/datastore_v3/published_lineage.ts";
import { processStateOf } from "../src/infrastructure/runtime/process_ancestry.ts";
import {
  hostLitestreamProcesses,
  isSupervisorFor,
} from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import type { CommitLogUnitOfWork } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";

/**
 * resumed first in case the test stopped it; on macOS signalling a group whose
 * processes exited but are not reaped fails with EPERM, which means the group
 * is already gone
 */
export function killSidecarAtTeardown(pid: number): void {
  hostLitestreamProcesses.signal(pid, "SIGCONT");
  try {
    hostLitestreamProcesses.signalGroup(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Deno.errors.PermissionDenied)) throw error;
  }
}

export type SidecarState = "gone" | "zombie" | "running" | "unknown";

export interface SidecarProbe {
  kill(pid: number): void;
  state(pid: number): SidecarState;
  commandLine(pid: number): Promise<string | undefined>;
  readonly timeoutMs: number;
}

const HOST_SIDECAR_PROBE: SidecarProbe = {
  kill: killSidecarAtTeardown,
  state(pid) {
    if (!hostLitestreamProcesses.isAlive(pid)) return "gone";
    const state = processStateOf(pid);
    if (state === undefined) return "unknown";
    return state.zombie ? "zombie" : "running";
  },
  commandLine: (pid) => hostLitestreamProcesses.commandLine(pid),
  timeoutMs: 10_000,
};

/**
 * a killed sidecar whose spawning Worker is gone can stay a zombie until
 * something reaps it; it holds nothing, so it counts as stopped
 */
export async function stopSidecarsAtTeardown(
  pids: Iterable<number>,
  probe: SidecarProbe = HOST_SIDECAR_PROBE,
): Promise<void> {
  const all = [...pids];
  for (const pid of all) probe.kill(pid);
  const left = () =>
    all.filter((pid) => {
      const state = probe.state(pid);
      return state === "running" || state === "unknown";
    });
  try {
    await waitFor(() => left().length === 0, "every sidecar to stop", {
      timeoutMs: probe.timeoutMs,
    });
  } catch (error) {
    const still = left();
    if (still.length === 0) return;
    const named = await Promise.all(
      still.map(async (pid) =>
        `${pid} ${probe.state(pid)}: ${
          await probe.commandLine(pid) ?? "command line unreadable"
        }`
      ),
    );
    throw new Error(
      `${messageOf(error)}; still running: ${named.join("; ")}`,
      { cause: error },
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** a teardown failure never hides the body's own failure */
export async function runThenTearDown<T>(
  body: () => Promise<T>,
  teardown: () => Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (bodyError) {
    try {
      await teardown();
    } catch (teardownError) {
      throw new Error(
        `${messageOf(bodyError)} (teardown also failed: ${
          messageOf(teardownError)
        })`,
        { cause: new AggregateError([bodyError, teardownError]) },
      );
    }
    throw bodyError;
  }
  await teardown();
  return result;
}

export const LITESTREAM_BINARY = Deno.env.get("SWAMP_LITESTREAM_PATH");

export const SIDECAR_TESTS_IGNORED = Deno.build.os === "windows" ||
  LITESTREAM_BINARY === undefined || LITESTREAM_BINARY === "";

/** Second-scale timings, so idle exits and deadlines happen within a test. */
export const TEST_TIMINGS: ReplicatorTimings = {
  ...DEFAULT_REPLICATOR_TIMINGS,
  idleMs: 3_000,
  stopWaitMs: 2_000,
  tickMs: 250,
  lockWaitMs: 4_000,
  startWaitMs: 15_000,
  probeMs: 1_000,
  pollMs: 25,
};

export interface ReplicationEnv {
  readonly root: string;
  readonly datastorePath: string;
  readonly repoDir: string;
  readonly replicaRoot: string;
  readonly privateRoot: string;
  readonly config: { readonly type: "filesystem"; readonly path: string };
  paths(): Promise<ReplicationPaths>;
  /** supervisors launched in this env, known even once a presence is removed */
  launchedSupervisors(): number[];
}

/** under /tmp because the macOS TMPDIR is too long for a socket path */
export async function withReplicationEnv(
  fn: (env: ReplicationEnv) => Promise<void>,
  options: {
    readonly timings?: Partial<ReplicatorTimings>;
    readonly deps?: Partial<ReplicatorDeps>;
    readonly syncDeadlineMs?: number;
  } = {},
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-ls-int-" }),
  );
  const datastorePath = join(root, "ds");
  const replicaRoot = join(root, "replica");
  const privateRoot = join(root, "priv");
  await initializeV3Datastore(datastorePath, "test");
  const repoDir = join(root, "repo");
  await Deno.mkdir(repoDir, { recursive: true });
  let paths: Promise<ReplicationPaths> | undefined;
  const launched = new Set<number>();
  const env: ReplicationEnv = {
    root,
    datastorePath,
    repoDir,
    replicaRoot,
    privateRoot,
    config: { type: "filesystem", path: datastorePath },
    // computed once inside the replica setting, so the cleanup outside it finds
    // the same sidecar
    paths: () =>
      paths ??= (async () => {
        const commitsDb = v3CommitsDbPath(datastorePath, repoDir);
        await Deno.mkdir(dirname(commitsDb), { recursive: true });
        return await replicationPathsFor(commitsDb, privateRoot);
      })(),
    launchedSupervisors: () => [...launched],
  };
  setV3ReplicationForTesting(
    {
      // Every supervisor a test starts is remembered, and killed after it.
      processes: {
        ...hostLitestreamProcesses,
        launch: (launch) => {
          const pid = hostLitestreamProcesses.launch(launch);
          startedPids.add(pid);
          launched.add(pid);
          return pid;
        },
      },
      privateRoot,
      timings: { ...TEST_TIMINGS, ...options.timings },
      ...options.deps,
    },
    options.syncDeadlineMs !== undefined
      ? { syncDeadlineMs: options.syncDeadlineMs }
      : {},
  );
  try {
    await withMockedEnv(
      { [V3_REPLICA_ENV]: JSON.stringify({ type: "file", path: replicaRoot }) },
      async () => {
        await env.paths();
        await fn(env);
      },
    );
  } finally {
    await closeV3Datastores().catch(() => {});
    setV3ReplicationForTesting(undefined);
    await killSidecars(env);
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

async function killSidecars(env: ReplicationEnv): Promise<void> {
  const paths = await env.paths().catch(() => undefined);
  if (paths === undefined) return;
  for (const pid of startedPids) {
    const line = await hostLitestreamProcesses.commandLine(pid);
    if (isSupervisorFor(line, paths.commitsDb)) killSidecarAtTeardown(pid);
  }
  startedPids.clear();
}

const startedPids = new Set<number>();

export async function presenceOf(
  env: ReplicationEnv,
): Promise<PresenceRecord | undefined> {
  const read = await readPresence(await env.paths());
  if (read.kind !== "found") return undefined;
  startedPids.add(read.record.supervisorPid);
  return read.record;
}

// plants only once no sidecar check can still overwrite it: a running check
// is of the acknowledged TXID, and the sidecar checks no TXID until a new
// snapshot, so an earlier verdict is final once its sidecar is gone
export async function plantBrokenVerdict(
  paths: ReplicationPaths,
  lineageFence: number,
): Promise<void> {
  let acknowledged: string | undefined;
  await waitFor(
    async () => {
      const copy = await readCopyState(paths);
      const verdict = await readReplicaVerification(paths);
      if (
        copy?.lineageFence !== lineageFence ||
        verdict?.lineageFence !== lineageFence
      ) {
        return false;
      }
      acknowledged = copy.txid;
      return normalizeTxid(verdict.txid) === normalizeTxid(copy.txid) ||
        !await sidecarRunning(paths);
    },
    "the sidecar to finish checking the acknowledged TXID",
    { timeoutMs: 20_000 },
  );
  const verdict = (await readReplicaVerification(paths))!;
  await writeReplicaVerification(paths, {
    ...verdict,
    txid: acknowledged!,
    checkedAt: new Date().toISOString(),
    ok: false,
    error: "the restored database failed SQLite's integrity check",
  });
}

async function sidecarRunning(paths: ReplicationPaths): Promise<boolean> {
  const read = await readPresence(paths);
  if (read.kind !== "found") return false;
  const pid = read.record.supervisorPid;
  return hostLitestreamProcesses.isAlive(pid) &&
    isSupervisorFor(
      await hostLitestreamProcesses.commandLine(pid),
      paths.commitsDb,
    );
}

export async function writeCommand(
  env: ReplicationEnv,
  commits = 1,
  options: { readonly bytes?: number; readonly holds?: number } = {},
): Promise<void> {
  try {
    for (let i = 0; i < (options.holds ?? 1); i++) {
      await holdV3Writer(env.config, env.repoDir);
    }
    await commitIn(env, commits, options.bytes);
    await presenceOf(env);
  } catch (error) {
    await closeV3Datastores().catch(() => {});
    throw error;
  }
  await closeV3Datastores();
}

export async function commitIn(
  env: Pick<ReplicationEnv, "repoDir" | "config">,
  commits: number,
  bytes = 64,
): Promise<void> {
  const engine = v3DatastoreFor(env.repoDir, env.config).engineFor(
    () => Promise.resolve(),
    () => {
      throw new Error("no run repository needed");
    },
  );
  for (let i = 0; i < commits; i++) {
    await engine.runRoot({}, async () => {
      const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
      const content = new Uint8Array(bytes);
      crypto.getRandomValues(content.subarray(0, Math.min(bytes, 65536)));
      await unit.stageOps([
        new AutoDefinitionChanges(crypto.randomUUID()).write(
          recordKeyOf(["auto-definitions", `${crypto.randomUUID()}.yaml`]),
          content,
        ),
      ]);
      await unit.commit();
    });
  }
}

export function commitCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM commits").get() as {
      n: number;
    }).n;
  } finally {
    db.close();
  }
}

export function logicalBytes(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const pages = (db.prepare("PRAGMA page_count").get() as {
      page_count: number;
    }).page_count;
    const size = (db.prepare("PRAGMA page_size").get() as {
      page_size: number;
    }).page_size;
    return pages * size;
  } finally {
    db.close();
  }
}

export async function restoredCommitCount(
  env: ReplicationEnv,
  replicaPath: string,
): Promise<number> {
  const out = join(env.root, `restored-${crypto.randomUUID()}.db`);
  const result = await new Deno.Command(LITESTREAM_BINARY!, {
    args: ["restore", "-o", out, `file://${replicaPath}`],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `litestream restore failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return commitCount(out);
}

export async function bytesUnder(dir: string): Promise<number> {
  let total = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      total += entry.isDirectory
        ? await bytesUnder(path)
        : (await Deno.stat(path)).size;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return total;
}
