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
 * The supervisor of a v3 writer's Litestream sidecar (swamp-club#3416): the
 * process that outlives a write command, runs Litestream as its child, and
 * stops it once the sidecar has been idle for its timeout.
 *
 * - It holds `supervisor.lock` exclusively for its whole life, so a command
 *   learns whether a sidecar runs by trying that lock, and the kernel drops
 *   it when the supervisor dies. Only the holder writes `presence.json`.
 * - It exits only once it holds `use.lock` exclusively after the idle
 *   timeout, so it never stops Litestream during a command that uses it.
 * - Litestream runs in the supervisor's process group (the supervisor is
 *   launched detached), so killing the group stops both, recorded or not.
 *
 * Launched by `LitestreamReplicator` with {@link supervisorArgs}, and entered
 * from `main.ts` before the CLI runs, or from
 * `replication_supervisor_entry.ts` when run from source.
 *
 * @module
 */

import { shouldIdleExit } from "../../../domain/datastore_v3/litestream_replication.ts";
import {
  REPLICA_VERIFY_INTERVAL_MS,
  type ReplicaVerification,
  shouldVerifyReplica,
} from "../../../domain/datastore_v3/replica_verification.ts";
import {
  clearReplacementMarks,
  ensurePrivateDir,
  ensureSharedDir,
  readCopyState,
  readReplicaVerification,
  removeOwnPresence,
  type ReplicationPaths,
  replicationPathsFor,
  writePresence,
} from "./replication_files.ts";
import { SUPERVISOR_MARKER } from "./litestream_processes.ts";
import { localProcess } from "../process_identity.ts";
import {
  type LitestreamReplicaType,
  parseLitestreamReplicaType,
} from "./sidecar_env.ts";

/** What a supervisor is started with. */
export interface SupervisorOptions {
  /** The canonical `commits.db`. */
  readonly commitsDb: string;
  /** The per-user root of the config and socket. */
  readonly privateRoot: string;
  /** The lineage the config replicates, recorded in `presence.json`. */
  readonly lineageFence: number;
  readonly replicaPath: string;
  /**
   * The kind of replica, which narrows the environment Litestream runs
   * with (swamp-club#3534). Without it Litestream inherits the
   * supervisor's whole environment.
   */
  readonly replicaType?: LitestreamReplicaType;
  /** How long the sidecar stays up unused. */
  readonly idleMs: number;
  /** How long Litestream gets to stop before it is killed. */
  readonly stopWaitMs: number;
  /** How often the idle check runs. */
  readonly tickMs: number;
  /**
   * How often, at most, the sidecar restores its lineage to check it
   * (swamp-club#3935); {@link REPLICA_VERIFY_INTERVAL_MS} when absent.
   */
  readonly verifyIntervalMs?: number;
}

/** A running Litestream child. */
export interface LitestreamChild {
  readonly pid: number;
  readonly exited: Promise<unknown>;
  kill(signal: Deno.Signal): void;
}

/** What the supervisor does to the world, replaceable in tests. */
export interface SupervisorDeps {
  /** Resolves the hash-checked binary, right before each start. */
  resolveBinary(): Promise<string>;
  startLitestream(
    binary: string,
    configPath: string,
    replicaType?: LitestreamReplicaType,
  ): LitestreamChild;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Resolves once the supervisor is asked to stop (SIGTERM, SIGINT). */
  stopRequested?: Promise<void>;
  /**
   * Restores the lineage as a reader would and records the verdict
   * (swamp-club#3935); see `replica_verifier.ts`. Without it the sidecar
   * never checks its replica.
   */
  verifyReplica?(request: SupervisorVerifyRequest): Promise<unknown>;
}

/** What a supervisor asks {@link SupervisorDeps.verifyReplica} to check. */
export interface SupervisorVerifyRequest {
  readonly paths: ReplicationPaths;
  readonly lineageFence: number;
  readonly replicaType: LitestreamReplicaType;
  readonly signal: AbortSignal;
}

/** Why a supervisor ended. */
export type SupervisorExit =
  | "another-supervisor"
  | "idle"
  | "litestream-exited"
  | "stop-requested";

/**
 * How long a new supervisor retries the lock a command's probe may hold:
 * the launching command probes it briefly on every poll while it waits for
 * the supervisor, so a slow start must outlast many probes.
 */
const LOCK_RETRY_MS = 5_000;
const LOCK_RETRY_STEP_MS = 50;

/** The arguments that start a supervisor for `options`. */
export function supervisorArgs(options: SupervisorOptions): string[] {
  return [
    SUPERVISOR_MARKER,
    "--db",
    options.commitsDb,
    "--private-root",
    options.privateRoot,
    "--lineage",
    String(options.lineageFence),
    "--replica-path",
    options.replicaPath,
    ...(options.replicaType !== undefined
      ? ["--replica-type", options.replicaType]
      : []),
    "--idle-ms",
    String(options.idleMs),
    "--stop-wait-ms",
    String(options.stopWaitMs),
    "--tick-ms",
    String(options.tickMs),
    ...(options.verifyIntervalMs !== undefined
      ? ["--verify-interval-ms", String(options.verifyIntervalMs)]
      : []),
  ];
}

/** Parses {@link supervisorArgs}, or returns undefined when they are not. */
export function parseSupervisorArgs(
  args: readonly string[],
): SupervisorOptions | undefined {
  if (args[0] !== SUPERVISOR_MARKER) return undefined;
  const values = new Map<string, string>();
  for (let i = 1; i + 1 < args.length; i += 2) values.set(args[i], args[i + 1]);
  const text = (key: string) => values.get(key);
  const count = (key: string) => {
    const value = Number(values.get(key));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };
  const commitsDb = text("--db");
  const privateRoot = text("--private-root");
  const replicaPath = text("--replica-path");
  const replicaType = parseLitestreamReplicaType(text("--replica-type"));
  const lineageFence = count("--lineage");
  const idleMs = count("--idle-ms");
  const stopWaitMs = count("--stop-wait-ms");
  const tickMs = count("--tick-ms");
  const verifyIntervalMs = count("--verify-interval-ms");
  if (
    commitsDb === undefined || privateRoot === undefined ||
    replicaPath === undefined || lineageFence === undefined ||
    idleMs === undefined || stopWaitMs === undefined || tickMs === undefined
  ) {
    return undefined;
  }
  return {
    commitsDb,
    privateRoot,
    lineageFence,
    replicaPath,
    ...(replicaType !== undefined ? { replicaType } : {}),
    idleMs,
    stopWaitMs,
    tickMs,
    ...(verifyIntervalMs !== undefined ? { verifyIntervalMs } : {}),
  };
}

/**
 * Runs a supervisor until its sidecar has idled out, Litestream has exited,
 * or it is asked to stop. Resolves with why it ended.
 */
export async function runReplicationSupervisor(
  options: SupervisorOptions,
  deps: SupervisorDeps,
): Promise<SupervisorExit> {
  const paths = await replicationPathsFor(
    options.commitsDb,
    options.privateRoot,
  );
  await ensurePrivateDir(paths);
  if (await ensureSharedDir(paths) !== "own") return "another-supervisor";
  const lock = await Deno.open(paths.supervisorLock, {
    read: true,
    write: true,
    create: true,
  });
  try {
    if (!await takeSupervisorLock(lock, deps)) return "another-supervisor";
    return await superviseHeld(paths, options, deps);
  } finally {
    // Closing the file releases the lock.
    lock.close();
  }
}

/**
 * Takes the supervisor lock, retrying briefly: a command probes it with a
 * try-and-release, which must not make a new supervisor give up.
 */
async function takeSupervisorLock(
  lock: Deno.FsFile,
  deps: SupervisorDeps,
): Promise<boolean> {
  const until = deps.now() + LOCK_RETRY_MS;
  while (true) {
    if (await lock.tryLock(true)) return true;
    if (deps.now() >= until) return false;
    await deps.sleep(LOCK_RETRY_STEP_MS);
  }
}

async function superviseHeld(
  paths: ReplicationPaths,
  options: SupervisorOptions,
  deps: SupervisorDeps,
): Promise<SupervisorExit> {
  const presence = {
    supervisorPid: Deno.pid,
    uid: Deno.uid(),
    hostname: Deno.hostname(),
    // Its owner is judged by this, not the hostname, which may change while
    // it runs (swamp-club#3801).
    process: (await localProcess()).identity,
    lineageFence: options.lineageFence,
    replicaPath: options.replicaPath,
  };
  await writePresence(paths, presence);
  let child: LitestreamChild;
  try {
    await clearReplacementMarks(paths);
    await touchUseLock(paths, deps.now());
    // A socket a killed sidecar left behind would make Litestream fail to
    // bind.
    await Deno.remove(paths.socket).catch(() => {});
    child = deps.startLitestream(
      await deps.resolveBinary(),
      paths.config,
      options.replicaType,
    );
  } catch (error) {
    // No record of a supervisor that never ran Litestream.
    await cleanUp(paths);
    throw error;
  }
  let exited = false;
  child.exited.then(() => {
    exited = true;
  }, () => {
    exited = true;
  });
  let stopRequested = false;
  // Observed, never awaited: the loop below polls the flags these set.
  deps.stopRequested?.then(() => {
    stopRequested = true;
  }, () => {});
  const verifier = new ReplicaCheck(paths, options, deps);
  try {
    await writePresence(paths, { ...presence, litestreamPid: child.pid });
    while (true) {
      await deps.sleep(options.tickMs);
      if (exited) return "litestream-exited";
      if (stopRequested) {
        await stopChild(child, options.stopWaitMs, deps);
        return "stop-requested";
      }
      const idle = shouldIdleExit(
        await lastUsedAt(paths),
        deps.now(),
        options.idleMs,
      );
      await verifier.maybeStart(idle);
      // Never stop while a check runs: it covers what this sidecar uploaded.
      if (!idle || verifier.running) continue;
      // Idle for the whole timeout: stop only while no command uses it.
      const use = await Deno.open(paths.useLock, {
        read: true,
        write: true,
        create: true,
      });
      try {
        if (!await use.tryLock(true)) continue;
        // A command may have used and released it since the check above.
        if (
          !shouldIdleExit(await lastUsedAt(paths), deps.now(), options.idleMs)
        ) {
          continue;
        }
        await stopChild(child, options.stopWaitMs, deps);
        await cleanUp(paths);
        return "idle";
      } finally {
        use.close();
      }
    }
  } finally {
    await verifier.stop();
    if (!exited) child.kill("SIGKILL");
    await cleanUp(paths);
  }
}

/**
 * The sidecar's checks of its own replica (swamp-club#3935): at most one
 * at a time, started from the tick loop and never awaited by it, so a long
 * restore delays neither a stop request nor noticing Litestream exit.
 */
class ReplicaCheck {
  #running: Promise<void> | undefined;
  #lastStartedAtMs: number | undefined;
  #lastAttemptedTxid: string | undefined;
  readonly #abort = new AbortController();

  constructor(
    private readonly paths: ReplicationPaths,
    private readonly options: SupervisorOptions,
    private readonly deps: SupervisorDeps,
  ) {}

  get running(): boolean {
    return this.#running !== undefined;
  }

  /** Starts a check when one is due; see `shouldVerifyReplica`. */
  async maybeStart(idle: boolean): Promise<void> {
    const verify = this.deps.verifyReplica;
    const replicaType = this.options.replicaType;
    if (verify === undefined || replicaType === undefined || this.running) {
      return;
    }
    const copy = await readCopyState(this.paths);
    const acknowledgedTxid = copy?.lineageFence === this.options.lineageFence
      ? copy.txid
      : undefined;
    const last: ReplicaVerification | undefined = await readReplicaVerification(
      this.paths,
    );
    const due = shouldVerifyReplica({
      lineageFence: this.options.lineageFence,
      acknowledgedTxid,
      last,
      lastStartedAtMs: this.#lastStartedAtMs,
      lastAttemptedTxid: this.#lastAttemptedTxid,
      nowMs: this.deps.now(),
      idle,
      intervalMs: this.options.verifyIntervalMs ?? REPLICA_VERIFY_INTERVAL_MS,
    });
    if (!due) return;
    this.#lastStartedAtMs = this.deps.now();
    this.#lastAttemptedTxid = acknowledgedTxid;
    this.#running = verify({
      paths: this.paths,
      lineageFence: this.options.lineageFence,
      replicaType,
      signal: this.#abort.signal,
    }).then(
      () => {},
      // No verdict: tried again after the interval.
      () => {},
    ).finally(() => {
      this.#running = undefined;
    });
  }

  /** Cancels a running check and waits for it. */
  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#running;
  }
}

/** Stops Litestream, killing it once `stopWaitMs` has passed. */
async function stopChild(
  child: LitestreamChild,
  stopWaitMs: number,
  deps: SupervisorDeps,
): Promise<void> {
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    child.exited.then(() => true, () => true),
    deps.sleep(stopWaitMs).then(() => false),
  ]);
  if (!stopped) {
    // Its own child: no argument check is needed.
    child.kill("SIGKILL");
    await child.exited.catch(() => {});
  }
}

async function cleanUp(paths: ReplicationPaths): Promise<void> {
  await removeOwnPresence(paths, Deno.pid);
  await Deno.remove(paths.socket).catch(() => {});
}

/** When a command last released the sidecar: `use.lock`'s mtime. */
async function lastUsedAt(paths: ReplicationPaths): Promise<number> {
  try {
    return (await Deno.stat(paths.useLock)).mtime?.getTime() ?? 0;
  } catch {
    return 0;
  }
}

/** Records a use of the sidecar at `nowMs`. */
export async function touchUseLock(
  paths: Pick<ReplicationPaths, "useLock">,
  nowMs: number,
): Promise<void> {
  const file = await Deno.open(paths.useLock, { write: true, create: true });
  file.close();
  const now = new Date(nowMs);
  await Deno.utime(paths.useLock, now, now);
}
