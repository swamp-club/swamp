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
 * holds supervisor.lock for its whole life as the liveness signal; exits only
 * holding use.lock exclusively; Litestream shares its process group, so killing
 * the group stops both
 */

import { shouldIdleExit } from "../../../domain/datastore_v3/litestream_replication.ts";
import {
  REPLICA_VERIFY_BACKSTOP_MS,
  REPLICA_VERIFY_RETRY_MS,
  type ReplicaVerification,
  type ReplicaVerifyAttempt,
  shouldVerifyReplica,
  snapshotReadAt,
} from "../../../domain/datastore_v3/replica_verification.ts";
import { normalizeTxid } from "../../../domain/datastore_v3/published_lineage.ts";
import {
  clearReplacementMarks,
  clearVerifyLeftovers,
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

export interface SupervisorOptions {
  readonly commitsDb: string;
  readonly privateRoot: string;
  readonly lineageFence: number;
  readonly replicaPath: string;
  /**
   * narrows the environment Litestream runs with; without it Litestream
   * inherits the supervisor's whole environment
   */
  readonly replicaType?: LitestreamReplicaType;
  readonly idleMs: number;
  readonly stopWaitMs: number;
  readonly tickMs: number;
  readonly verifyIntervalMs?: number;
}

export interface LitestreamChild {
  readonly pid: number;
  readonly exited: Promise<unknown>;
  kill(signal: Deno.Signal): void;
}

export interface SupervisorDeps {
  resolveBinary(): Promise<string>;
  startLitestream(
    binary: string,
    configPath: string,
    replicaType?: LitestreamReplicaType,
  ): LitestreamChild;
  now(): number;
  sleep(ms: number): Promise<void>;
  stopRequested?: Promise<void>;
  verifyReplica?(request: SupervisorVerifyRequest): Promise<unknown>;
  /**
   * without it no snapshot is ever new, and only a new lineage or the backstop
   * starts a check
   */
  readSnapshotTxid?(
    request: SupervisorSnapshotRequest,
  ): Promise<string | undefined>;
}

export interface SupervisorSnapshotRequest {
  readonly paths: ReplicationPaths;
  readonly replicaType: LitestreamReplicaType;
  readonly signal: AbortSignal;
}

export interface SupervisorVerifyRequest {
  readonly paths: ReplicationPaths;
  readonly lineageFence: number;
  readonly replicaType: LitestreamReplicaType;
  readonly signal: AbortSignal;
  readonly snapshotTxid?: string;
}

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
    // its owner is judged by this, not the hostname, which may change while it
    // runs
    process: (await localProcess()).identity,
    lineageFence: options.lineageFence,
    replicaPath: options.replicaPath,
  };
  await writePresence(paths, presence);
  let child: LitestreamChild;
  try {
    await clearReplacementMarks(paths);
    await clearVerifyLeftovers(paths);
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

export const SNAPSHOT_POLL_INTERVAL_MS = 15 * 60 * 1000;

const SNAPSHOT_POLL_DEADLINE_MS = 60 * 1000;

/**
 * at most one check at a time, never awaited by the tick loop, so a long
 * restore delays neither stop nor noticing Litestream exit; snapshots are
 * listed rate-limited, and once more at idle
 */
class ReplicaCheck {
  #running: Promise<void> | undefined;
  #lastAttempt: ReplicaVerifyAttempt | undefined;
  #snapshot: { txid: string | undefined; polledAtMs: number } | undefined;
  #polledThisIdle = false;
  readonly #abort = new AbortController();

  constructor(
    private readonly paths: ReplicationPaths,
    private readonly options: SupervisorOptions,
    private readonly deps: SupervisorDeps,
  ) {}

  get running(): boolean {
    return this.#running !== undefined;
  }

  async maybeStart(idle: boolean): Promise<void> {
    const verify = this.deps.verifyReplica;
    const replicaType = this.options.replicaType;
    if (verify === undefined || replicaType === undefined || this.running) {
      return;
    }
    if (!idle) this.#polledThisIdle = false;
    const copy = await readCopyState(this.paths);
    const acknowledgedTxid = copy?.lineageFence === this.options.lineageFence
      ? copy.txid
      : undefined;
    const last: ReplicaVerification | undefined = await readReplicaVerification(
      this.paths,
    );
    if (!this.#uncovered(acknowledgedTxid, last)) return;
    const now = this.deps.now();
    const readSnapshot = this.deps.readSnapshotTxid;
    if (
      readSnapshot !== undefined &&
      (this.#snapshot === undefined ||
        now - this.#snapshot.polledAtMs >= SNAPSHOT_POLL_INTERVAL_MS ||
        (idle && !this.#polledThisIdle))
    ) {
      if (idle) this.#polledThisIdle = true;
      this.#track(
        readSnapshot({
          paths: this.paths,
          replicaType,
          signal: AbortSignal.any([
            this.#abort.signal,
            AbortSignal.timeout(SNAPSHOT_POLL_DEADLINE_MS),
          ]),
        }).then(
          (txid) => {
            this.#snapshot = { txid, polledAtMs: this.deps.now() };
          },
          // Unknown: no snapshot is new until a listing succeeds.
          () => {
            this.#snapshot = { txid: undefined, polledAtMs: this.deps.now() };
          },
        ),
      );
      return;
    }
    const snapshotTxid = this.#snapshot?.txid;
    const due = shouldVerifyReplica({
      lineageFence: this.options.lineageFence,
      acknowledgedTxid,
      last,
      snapshotTxid,
      lastAttempt: this.#lastAttempt,
      nowMs: now,
      idle,
      backstopMs: this.options.verifyIntervalMs ?? REPLICA_VERIFY_BACKSTOP_MS,
      retryMs: REPLICA_VERIFY_RETRY_MS,
    });
    if (!due) return;
    // Only a snapshot this check reads through: a newer one is still new
    // to the next decision.
    const attempt: ReplicaVerifyAttempt = {
      startedAtMs: now,
      txid: acknowledgedTxid,
      snapshotTxid: snapshotReadAt(snapshotTxid, acknowledgedTxid),
    };
    this.#lastAttempt = attempt;
    this.#track(
      verify({
        paths: this.paths,
        lineageFence: this.options.lineageFence,
        replicaType,
        signal: this.#abort.signal,
        ...(snapshotTxid !== undefined ? { snapshotTxid } : {}),
      }).then(
        () => {},
        () => {},
      ).finally(() => {
        // The retry delay counts from here: a check can run 30 minutes.
        this.#lastAttempt = { ...attempt, endedAtMs: this.deps.now() };
      }),
    );
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#running;
  }

  #uncovered(
    acknowledgedTxid: string | undefined,
    last: ReplicaVerification | undefined,
  ): boolean {
    const acknowledged = normalizeTxid(acknowledgedTxid);
    if (acknowledged === undefined) return false;
    return last === undefined ||
      last.lineageFence !== this.options.lineageFence ||
      normalizeTxid(last.txid) !== acknowledged;
  }

  #track(work: Promise<void>): void {
    this.#running = work.finally(() => {
      this.#running = undefined;
    });
  }
}

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

async function lastUsedAt(paths: ReplicationPaths): Promise<number> {
  try {
    return (await Deno.stat(paths.useLock)).mtime?.getTime() ?? 0;
  } catch {
    return 0;
  }
}

export async function touchUseLock(
  paths: Pick<ReplicationPaths, "useLock">,
  nowMs: number,
): Promise<void> {
  const file = await Deno.open(paths.useLock, { write: true, create: true });
  file.close();
  const now = new Date(nowMs);
  await Deno.utime(paths.useLock, now, now);
}
