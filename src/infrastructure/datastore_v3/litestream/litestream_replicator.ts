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
 * The Litestream sidecar a v3 writer replicates `commits.db` through
 * (swamp-club#3416, Phase 4 D1): reused across commands, started when none
 * runs, replaced when it is frozen, on another lineage, or cannot upload.
 *
 * A command observes the sidecar while it holds `use.lock` shared, so the
 * sidecar cannot idle out between what the command saw and what it does.
 * Liveness comes from `supervisor.lock`, which the supervisor holds for its
 * whole life. A process is signalled only after its arguments show it is
 * this database's own; anything a command cannot verify is waited for, then
 * refused, so two sidecars never share a replica path.
 *
 * Before a write command reports success it forces one sync, checks that
 * the replica has every commit, then checks its writer lease.
 *
 * @module
 */

import { dirname, fromFileUrl, join } from "@std/path";
import {
  decideLineage,
  replicaPathFor,
  type ReplicationLineage,
} from "../../../domain/datastore_v3/replication_lineage.ts";
import {
  decideSidecarAction,
  isReplicated,
  type PresenceObservation,
  SIDECAR_IDLE_TIMEOUT_MS,
  type SidecarAction,
  V3ReplicationError,
  V3ReplicationUnavailableError,
} from "../../../domain/datastore_v3/litestream_replication.ts";
import { markErrorPaths } from "../../../domain/errors.ts";
import {
  type LitestreamControl,
  LitestreamControlError,
} from "./litestream_control_client.ts";
import {
  isLitestreamFor,
  isSupervisorFor,
  type LitestreamProcesses,
  type SupervisorLaunch,
} from "./litestream_processes.ts";
import {
  defaultPrivateRoot,
  ensurePrivateDir,
  ensureSharedDir,
  isMarkedForReplacement,
  litestreamReplicaPath,
  markForReplacement,
  readLineage,
  readPresence,
  renderLitestreamConfig,
  type ReplicationPaths,
  replicationPathsFor,
  writeLineage,
} from "./replication_files.ts";
import { replicaRootOf, type V3ReplicaSetting } from "./replica_setting.ts";
import { supervisorArgs, touchUseLock } from "./replication_supervisor.ts";

/** How long each part of finding a sidecar may take. */
export interface ReplicatorTimings {
  /** The sidecar's idle timeout, given to the supervisor. */
  readonly idleMs: number;
  /** How long the supervisor gives Litestream to stop before killing it. */
  readonly stopWaitMs: number;
  /** How often the supervisor checks for idleness. */
  readonly tickMs: number;
  /**
   * How long a command waits for the use lock. Longer than the stop wait,
   * so a command that arrives while an idle sidecar stops gets the lock
   * once it has gone, rather than failing just before.
   */
  readonly lockWaitMs: number;
  /** How long a sidecar may take to start answering, or a probe to answer. */
  readonly startWaitMs: number;
  /** How long one `GET /info` may take. */
  readonly probeMs: number;
  /** How often a waiting command looks again. */
  readonly pollMs: number;
}

/** The production timings: a five-minute idle sidecar. */
export const DEFAULT_REPLICATOR_TIMINGS: ReplicatorTimings = {
  idleMs: SIDECAR_IDLE_TIMEOUT_MS,
  stopWaitMs: 10_000,
  tickMs: 5_000,
  lockWaitMs: 20_000,
  startWaitMs: 15_000,
  probeMs: 2_000,
  pollMs: 50,
};

/** How a supervisor process is started: the command and its argument prefix. */
export interface SupervisorCommand {
  readonly command: string;
  readonly prefixArgs: readonly string[];
  /** The environment to give it; the current one when omitted. */
  readonly env?: Record<string, string>;
}

/** What the replicator does to the world, replaceable in tests. */
export interface ReplicatorDeps {
  readonly processes: LitestreamProcesses;
  readonly control: LitestreamControl;
  /** Resolves the hash-checked binary, so a download fails in the command. */
  resolveBinary(): Promise<string>;
  readonly supervisor: SupervisorCommand;
  readonly timings: ReplicatorTimings;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The per-user root of configs and sockets; `/tmp/swamp-<uid>` by default. */
  readonly privateRoot?: string;
}

/** What a writer asks for. */
export interface ReplicationRequest {
  readonly commitsDb: string;
  readonly replica: V3ReplicaSetting;
  /** The fence this process's writer lease holds. */
  readonly fence: number;
  /** Throws when this process's writer lease was taken over. */
  assertLeaseCurrent(): Promise<void>;
}

/** A command's use of the sidecar, from acquire to release. */
export interface ReplicationHandle {
  /** The lineage the sidecar replicates. */
  readonly lineageFence: number;
  /**
   * Forces one sync and confirms every commit made before it, then checks
   * the writer lease.
   *
   * @throws V3ReplicationError
   */
  sync(deadlineMs: number): Promise<void>;
  /** Whether the sidecar still answers on its control socket. */
  probe(): Promise<boolean>;
  /** Records the use and lets the sidecar idle out. Idempotent. */
  release(): Promise<void>;
}

/** The arguments a `deno run` of the supervisor entry needs, from source. */
export function sourceSupervisorCommand(): SupervisorCommand {
  const entry = fromFileUrl(
    new URL("./replication_supervisor_entry.ts", import.meta.url),
  );
  // The repo's import map, found from this file, since the supervisor runs
  // with its cwd outside the repo.
  const config = join(dirname(entry), "..", "..", "..", "..", "deno.json");
  return {
    command: Deno.execPath(),
    prefixArgs: ["run", "-A", "--config", config, entry],
  };
}

/** How this process starts a supervisor: itself, or `deno run` from source. */
export function hostSupervisorCommand(): SupervisorCommand {
  const execPath = Deno.execPath();
  return /[\\/]deno(\.exe)?$/.test(execPath)
    ? sourceSupervisorCommand()
    : { command: execPath, prefixArgs: [] };
}

/**
 * Manages this process's uses of Litestream sidecars: one handle per
 * canonical `commits.db`, shared by every caller while any holds it.
 */
export class LitestreamReplicator {
  readonly #held = new Map<string, { handle: SharedHandle; refs: number }>();

  constructor(private readonly deps: ReplicatorDeps) {}

  /**
   * Reuses, starts or replaces the sidecar for `request`, and holds it.
   *
   * @throws V3ReplicationUnavailableError when none can be used
   */
  async acquire(request: ReplicationRequest): Promise<ReplicationHandle> {
    const paths = await replicationPathsFor(
      request.commitsDb,
      this.deps.privateRoot ?? defaultPrivateRoot(),
    );
    const held = this.#held.get(paths.commitsDb);
    if (held !== undefined) {
      held.refs++;
      return held.handle.view(() => this.#releaseShared(paths.commitsDb));
    }
    const handle = await this.#acquireNew(paths, request);
    this.#held.set(paths.commitsDb, { handle, refs: 1 });
    return handle.view(() => this.#releaseShared(paths.commitsDb));
  }

  async #releaseShared(key: string): Promise<void> {
    const held = this.#held.get(key);
    if (held === undefined) return;
    held.refs--;
    if (held.refs > 0) return;
    this.#held.delete(key);
    await held.handle.release();
  }

  async #acquireNew(
    paths: ReplicationPaths,
    request: ReplicationRequest,
  ): Promise<SharedHandle> {
    await ensurePrivateDir(paths);
    if (await ensureSharedDir(paths) !== "own") {
      throw markErrorPaths(
        new V3ReplicationUnavailableError(
          `${paths.sharedDir} belongs to another user`,
        ),
        [paths.sharedDir],
      );
    }
    const lineage = await this.#lineage(paths, request);
    const replicaPath = litestreamReplicaPath(
      request.replica,
      replicaPathFor(request.replica.path, lineage.lineageFence),
    );
    const use = await Deno.open(paths.useLock, {
      read: true,
      write: true,
      create: true,
    });
    try {
      await this.#waitForLock(use, false, "the sidecar is busy stopping");
      const supervisorPid = await this.#findOrStart(
        paths,
        request.replica,
        lineage.lineageFence,
        replicaPath,
        use,
      );
      return new SharedHandle(
        paths,
        use,
        lineage.lineageFence,
        supervisorPid,
        this.deps,
        request.assertLeaseCurrent,
      );
    } catch (error) {
      // A failed acquire records no use: retrying must not keep an old
      // sidecar from idling out.
      use.close();
      throw error;
    }
  }

  /** The lineage the lease hook recorded, or one decided now if it could not. */
  async #lineage(
    paths: ReplicationPaths,
    request: ReplicationRequest,
  ): Promise<ReplicationLineage> {
    const root = replicaRootOf(request.replica);
    const recorded = await readLineage(paths);
    if (
      recorded !== undefined && recorded.replicaRoot === root &&
      recorded.lastFence === request.fence
    ) {
      return recorded;
    }
    const decided = decideLineage(recorded, root, request.fence).lineage;
    await writeLineage(paths, decided);
    return decided;
  }

  /** Polls a lock on `file` until it is taken, or throws past the wait. */
  async #waitForLock(
    file: Deno.FsFile,
    exclusive: boolean,
    busy: string,
  ): Promise<void> {
    const until = this.deps.now() + this.deps.timings.lockWaitMs;
    while (!await file.tryLock(exclusive)) {
      if (this.deps.now() >= until) {
        throw new V3ReplicationUnavailableError(busy);
      }
      await this.deps.sleep(this.deps.timings.pollMs);
    }
  }

  /** Finds a sidecar to reuse on this lineage, or makes one; its supervisor pid. */
  async #findOrStart(
    paths: ReplicationPaths,
    replica: V3ReplicaSetting,
    lineageFence: number,
    replicaPath: string,
    use: Deno.FsFile,
  ): Promise<number> {
    const timings = this.deps.timings;
    let waitingSince = this.deps.now();
    let launched = false;
    while (true) {
      const waited = this.deps.now() - waitingSince >= timings.startWaitMs;
      const step = await this.#observeAndDecide(paths, lineageFence, waited);
      const action = step.action;
      switch (action.kind) {
        case "reuse":
          return step.supervisorPid!;
        case "refuse":
          step.release();
          throw new V3ReplicationUnavailableError(action.reason);
        case "wait":
          step.release();
          await this.deps.sleep(timings.pollMs);
          continue;
        case "start": {
          if (launched) {
            // The launched supervisor has not taken its lock yet: it loads
            // before it does. Wait for it rather than launch another.
            step.release();
            if (waited) {
              throw new V3ReplicationUnavailableError(
                "the Litestream sidecar did not start in time",
              );
            }
            await this.deps.sleep(timings.pollMs);
            continue;
          }
          if (action.orphanPid !== undefined) {
            this.deps.processes.signal(action.orphanPid, "SIGKILL");
          }
          await this.#launch(paths, replica, lineageFence, replicaPath);
          // The probe lock goes once the supervisor is launched: it retries
          // the lock for long enough to get it.
          step.release();
          launched = true;
          waitingSince = this.deps.now();
          await this.deps.sleep(timings.pollMs);
          continue;
        }
        case "replace":
          step.release();
          await this.#replace(paths, action, use);
          launched = false;
          waitingSince = this.deps.now();
          continue;
      }
    }
  }

  /**
   * Observes the sidecar and decides. A free supervisor lock stays held by
   * this probe until the caller acts, so no supervisor can start between
   * the observation and a kill of the orphan it names.
   */
  async #observeAndDecide(
    paths: ReplicationPaths,
    lineageFence: number,
    waitedPastDeadline: boolean,
  ): Promise<{
    action: SidecarAction;
    supervisorPid?: number;
    release: () => void;
  }> {
    const probe = await Deno.open(paths.supervisorLock, {
      read: true,
      write: true,
      create: true,
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      probe.close();
    };
    try {
      const free = await probe.tryLock(true);
      if (!free) release();
      const read = await readPresence(paths);
      let presence: PresenceObservation;
      let answered = false;
      let marked = false;
      let supervisorPid: number | undefined;
      if (read.kind !== "found") {
        presence = read;
      } else {
        const record = read.record;
        supervisorPid = record.supervisorPid;
        const processes = this.deps.processes;
        const otherOwner = record.hostname !== Deno.hostname() ||
          record.uid !== Deno.uid();
        const supervisorVerified = !otherOwner && !free &&
          isSupervisorFor(
            await processes.commandLine(record.supervisorPid),
            paths.commitsDb,
          );
        const litestreamVerified = !otherOwner &&
          record.litestreamPid !== undefined &&
          processes.isAlive(record.litestreamPid) &&
          isLitestreamFor(
            await processes.commandLine(record.litestreamPid),
            paths.config,
          );
        presence = {
          kind: "found",
          otherOwner,
          supervisorVerified,
          supervisorPid: record.supervisorPid,
          ...(record.litestreamPid !== undefined
            ? { litestreamPid: record.litestreamPid }
            : {}),
          litestreamVerified,
          lineageFence: record.lineageFence,
        };
        if (!free && supervisorVerified) {
          marked = await isMarkedForReplacement(paths, record.supervisorPid);
          answered = await this.#answers(paths, record.litestreamPid);
        }
      }
      const action = decideSidecarAction({
        supervisorLock: free ? "free" : "held",
        presence,
        answered,
        lineageFence,
        marked,
        waitedPastDeadline,
      });
      return {
        action,
        ...(supervisorPid !== undefined ? { supervisorPid } : {}),
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Whether the socket answers, from the Litestream the record names. */
  async #answers(
    paths: ReplicationPaths,
    litestreamPid: number | undefined,
  ): Promise<boolean> {
    if (litestreamPid === undefined) return false;
    try {
      const info = await this.deps.control.info(
        paths.socket,
        this.deps.timings.probeMs,
      );
      return info.pid === undefined || info.pid === litestreamPid;
    } catch (error) {
      if (error instanceof LitestreamControlError) return false;
      throw error;
    }
  }

  /** Writes the config and launches a detached supervisor. */
  async #launch(
    paths: ReplicationPaths,
    replica: V3ReplicaSetting,
    lineageFence: number,
    replicaPath: string,
  ): Promise<void> {
    // Fails here, in the command, when the binary cannot be had.
    await this.deps.resolveBinary();
    await Deno.writeTextFile(
      paths.config,
      renderLitestreamConfig(paths, replica, replicaPath),
      { mode: 0o600 },
    );
    const timings = this.deps.timings;
    const supervisor = this.deps.supervisor;
    const launch: SupervisorLaunch = {
      command: supervisor.command,
      args: [
        ...supervisor.prefixArgs,
        ...supervisorArgs({
          commitsDb: paths.commitsDb,
          privateRoot: dirname(paths.privateDir),
          lineageFence,
          replicaPath,
          idleMs: timings.idleMs,
          stopWaitMs: timings.stopWaitMs,
          tickMs: timings.tickMs,
        }),
      ],
      // Outside any repo, so nothing in one is loaded.
      cwd: paths.privateDir,
      ...(supervisor.env !== undefined ? { env: supervisor.env } : {}),
    };
    this.deps.processes.launch(launch);
  }

  /**
   * Replaces a verified sidecar: takes `use.lock` exclusively on this
   * command's own descriptor, so no other command is using it, kills the
   * supervisor's group, waits for its lock to come free, then goes back to
   * a shared hold.
   */
  async #replace(
    paths: ReplicationPaths,
    action: Extract<SidecarAction, { kind: "replace" }>,
    use: Deno.FsFile,
  ): Promise<void> {
    await this.#waitForLock(
      use,
      true,
      "another command is using the sidecar this one must replace",
    );
    try {
      const processes = this.deps.processes;
      // Verified as this database's supervisor, which leads its own group,
      // its Litestream included.
      processes.signalGroup(action.supervisorPid, "SIGKILL");
      if (action.litestreamPid !== undefined) {
        processes.signal(action.litestreamPid, "SIGKILL");
      }
      const until = this.deps.now() + this.deps.timings.startWaitMs;
      while (!await this.#supervisorLockFree(paths)) {
        if (this.deps.now() >= until) {
          throw new V3ReplicationUnavailableError(
            "the Litestream sidecar being replaced did not stop",
          );
        }
        await this.deps.sleep(this.deps.timings.pollMs);
      }
      await Deno.remove(paths.socket).catch(() => {});
    } finally {
      // Back to shared on the same descriptor.
      await use.lock(false);
    }
  }

  async #supervisorLockFree(paths: ReplicationPaths): Promise<boolean> {
    const probe = await Deno.open(paths.supervisorLock, {
      read: true,
      write: true,
      create: true,
    });
    try {
      return await probe.tryLock(true);
    } finally {
      probe.close();
    }
  }
}

/** One acquired sidecar, shared by every caller in the process. */
class SharedHandle {
  #released = false;

  constructor(
    private readonly paths: ReplicationPaths,
    private readonly use: Deno.FsFile,
    readonly lineageFence: number,
    private readonly supervisorPid: number,
    private readonly deps: ReplicatorDeps,
    private readonly assertLeaseCurrent: () => Promise<void>,
  ) {}

  /** A caller's view: its release drops only its own reference. */
  view(releaseShared: () => Promise<void>): ReplicationHandle {
    let released = false;
    return {
      lineageFence: this.lineageFence,
      sync: (deadlineMs) => this.sync(deadlineMs),
      probe: () => this.probe(),
      release: async () => {
        if (released) return;
        released = true;
        await releaseShared();
      },
    };
  }

  async sync(deadlineMs: number): Promise<void> {
    let response;
    try {
      response = await this.deps.control.sync(
        this.paths.socket,
        this.paths.commitsDb,
        deadlineMs,
      );
    } catch (error) {
      if (error instanceof LitestreamControlError && error.timedOut) {
        // Still uploading, perhaps a large first snapshot: leave it be.
        throw new V3ReplicationError(
          `the sync did not finish within ${Math.round(deadlineMs / 1000)}s`,
          { cause: error },
        );
      }
      await this.#condemn();
      throw new V3ReplicationError(
        `the Litestream sidecar failed: ${messageOf(error)}`,
        { cause: error },
      );
    }
    if (!isReplicated(response)) {
      await this.#condemn();
      throw new V3ReplicationError(
        `Litestream answered ${JSON.stringify(response)}`,
      );
    }
    // The lease could have been taken over while the sync ran: a fenced
    // writer reports nothing as replicated.
    await this.assertLeaseCurrent();
  }

  async probe(): Promise<boolean> {
    try {
      await this.deps.control.info(
        this.paths.socket,
        this.deps.timings.probeMs,
      );
      return true;
    } catch (error) {
      if (error instanceof LitestreamControlError) return false;
      throw error;
    }
  }

  /** A sidecar that failed definitely is replaced by the next command. */
  async #condemn(): Promise<void> {
    await markForReplacement(this.paths, this.supervisorPid).catch(() => {});
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try {
      await touchUseLock(this.paths, this.deps.now());
    } finally {
      this.use.close();
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
