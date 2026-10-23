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
import { padFence } from "../../../domain/datastore_v3/writer_lease.ts";
import { normalizeTxid } from "../../../domain/datastore_v3/published_lineage.ts";
import { WriterFencedError } from "../../../domain/datastore_v3/writer_lease.ts";
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
  type PresenceRecord,
  readLineage,
  readPresence,
  renderLitestreamConfig,
  type ReplicationPaths,
  replicationPathsFor,
  writeLineage,
} from "./replication_files.ts";
import { replicaRootOf, type V3ReplicaSetting } from "./replica_setting.ts";
import {
  type LocalProcess,
  sameKernel,
} from "../../../domain/datastore_v3/process_liveness.ts";
import { hostnameOf, localProcess } from "../process_identity.ts";
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

/** What {@link ReplicationHandle.sync} runs between the sync and the lease check. */
export interface SyncOptions {
  beforeLeaseCheck?(txid: string): Promise<void>;
}

/** A command's use of the sidecar, from acquire to release. */
export interface ReplicationHandle {
  /** The lineage the sidecar replicates. */
  readonly lineageFence: number;
  /**
   * Forces one sync and confirms every commit made before it, then runs
   * `options.beforeLeaseCheck` with the replicated TXID (16 hex digits),
   * then checks the writer lease (swamp-club#3482: what a writer publishes
   * must be visible before its check passes). Resolves with the TXID.
   *
   * @throws V3ReplicationError
   */
  sync(
    deadlineMs: number,
    options?: SyncOptions,
  ): Promise<string>;
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
  readonly #held = new Map<string, HeldEntry>();
  /** Acquires in flight, which concurrent callers for the database join. */
  readonly #acquiring = new Map<string, Promise<HeldEntry>>();

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
    const key = paths.commitsDb;
    for (;;) {
      let entry = this.#held.get(key);
      // A held sidecar that stopped answering is not handed out again: the
      // entry is retired (its callers release it as they finish) and the
      // sidecar is found or made afresh.
      if (entry !== undefined && !await entry.handle.probe()) {
        if (this.#held.get(key) === entry) this.#held.delete(key);
        entry = undefined;
      }
      if (entry === undefined) {
        let acquiring = this.#acquiring.get(key);
        if (acquiring === undefined) {
          acquiring = this.#acquireNew(paths, request).then((handle) => {
            const made: HeldEntry = { handle, refs: 0 };
            this.#held.set(key, made);
            return made;
          }).finally(() => {
            this.#acquiring.delete(key);
          });
          this.#acquiring.set(key, acquiring);
        }
        entry = await acquiring;
      }
      // The last release may have retired the entry while this acquire
      // waited (swamp-club#3565): its handle is released, so it starts over.
      if (this.#held.get(key) !== entry) continue;
      const held = entry;
      held.refs++;
      return held.handle.view(() => this.#releaseShared(key, held));
    }
  }

  /** Drops one caller's hold on `entry`, releasing it with the last one. */
  async #releaseShared(key: string, entry: HeldEntry): Promise<void> {
    entry.refs--;
    if (entry.refs > 0) return;
    if (this.#held.get(key) === entry) this.#held.delete(key);
    await entry.handle.release();
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
      recorded !== undefined && root.matches(recorded.replicaRoot) &&
      recorded.lastFence === request.fence
    ) {
      return recorded;
    }
    const decided = decideLineage(recorded, root, request.fence);
    if (decided.kind === "conflict") {
      throw markErrorPaths(
        new V3ReplicationUnavailableError(
          `the writer lease's fence ${request.fence} would restart ` +
            `replication on a replica path this copy used before (the ` +
            `lease's records were recreated). Remove that path's ` +
            `_litestream/${padFence(request.fence)} history from the ` +
            `replica, then delete ${paths.lineage} to start a new lineage`,
        ),
        [paths.lineage],
      );
    }
    await writeLineage(paths, decided.lineage);
    return decided.lineage;
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
          try {
            if (action.orphanPid !== undefined) {
              this.deps.processes.signal(action.orphanPid, "SIGKILL");
            }
            await this.#launch(paths, replica, lineageFence, replicaPath);
          } finally {
            // The probe lock goes once the supervisor is launched (it retries
            // the lock for long enough to get it), and on a failed launch
            // too: a lock left held would block every later start.
            step.release();
          }
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
        const otherOwner = !isOwnHost(record, await localProcess()) ||
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
          replicaType: replica.type,
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
    // Converting a flock is not atomic: if this wait times out, the shared
    // hold may already be gone. The caller closes `use` on the error.
    await this.#waitForLock(
      use,
      true,
      "another command is using the sidecar this one must replace",
    );
    try {
      const processes = this.deps.processes;
      // Converting a flock is not atomic: while this command waited, its
      // shared hold lapsed and another command may have replaced the
      // sidecar. Kill only the supervisor the record still names, verified
      // again; otherwise the caller looks afresh.
      const now = await readPresence(paths);
      if (
        now.kind !== "found" ||
        now.record.supervisorPid !== action.supervisorPid ||
        !isSupervisorFor(
          await processes.commandLine(action.supervisorPid),
          paths.commitsDb,
        )
      ) {
        return;
      }
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
      // Back to shared on the same descriptor, polled like every other
      // wait here: the conversion is not atomic, so another command may
      // take the lock exclusively in between.
      await this.#waitForLock(
        use,
        false,
        "another command took the sidecar while this one replaced it",
      );
    }
  }

  /**
   * Stops the sidecar of the `commits.db` at `commitsDb`, when one runs, so
   * the copy can be replaced by a restore (swamp-club#3482), and keeps any
   * other from starting until the returned release: `use.lock` is held
   * exclusively throughout, which every acquire waits for. This process
   * must hold no use of that sidecar. A sidecar it cannot verify as this
   * user's, on this host, for this database, is refused, never killed.
   *
   * @throws V3ReplicationUnavailableError
   */
  async quiesce(commitsDb: string): Promise<() => void> {
    const paths = await replicationPathsFor(
      commitsDb,
      this.deps.privateRoot ?? defaultPrivateRoot(),
    );
    if (this.#held.has(paths.commitsDb)) {
      throw new V3ReplicationUnavailableError(
        "this process still holds the sidecar of the copy it must restore",
      );
    }
    if (await ensureSharedDir(paths) !== "own") {
      throw markErrorPaths(
        new V3ReplicationUnavailableError(
          `${paths.sharedDir} belongs to another user`,
        ),
        [paths.sharedDir],
      );
    }
    const use = await Deno.open(paths.useLock, {
      read: true,
      write: true,
      create: true,
    });
    try {
      await this.#waitForLock(
        use,
        true,
        "another command is using the sidecar of the copy this one must restore",
      );
      const processes = this.deps.processes;
      const read = await readPresence(paths);
      if (read.kind === "foreign") {
        throw markErrorPaths(
          new V3ReplicationUnavailableError(
            `${paths.presence} belongs to another user`,
          ),
          [paths.presence],
        );
      }
      if (!await this.#supervisorLockFree(paths)) {
        const record = read.kind === "found" ? read.record : undefined;
        if (
          record === undefined || !isOwnHost(record, await localProcess()) ||
          record.uid !== Deno.uid() ||
          !isSupervisorFor(
            await processes.commandLine(record.supervisorPid),
            paths.commitsDb,
          )
        ) {
          throw new V3ReplicationUnavailableError(
            "a Litestream sidecar this command cannot verify holds the copy " +
              "it must restore",
          );
        }
        processes.signalGroup(record.supervisorPid, "SIGKILL");
        if (record.litestreamPid !== undefined) {
          processes.signal(record.litestreamPid, "SIGKILL");
        }
        const until = this.deps.now() + this.deps.timings.startWaitMs;
        while (!await this.#supervisorLockFree(paths)) {
          if (this.deps.now() >= until) {
            throw new V3ReplicationUnavailableError(
              "the Litestream sidecar of the copy being restored did not stop",
            );
          }
          await this.deps.sleep(this.deps.timings.pollMs);
        }
      } else if (
        read.kind === "found" && read.record.litestreamPid !== undefined &&
        isOwnHost(read.record, await localProcess()) &&
        read.record.uid === Deno.uid() &&
        processes.isAlive(read.record.litestreamPid) &&
        isLitestreamFor(
          await processes.commandLine(read.record.litestreamPid),
          paths.config,
        )
      ) {
        // A Litestream its dead supervisor left behind.
        processes.signal(read.record.litestreamPid, "SIGKILL");
      }
      await Deno.remove(paths.socket).catch(() => {});
    } catch (error) {
      use.close();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      use.close();
    };
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

/** A held sidecar and how many callers in the process hold it. */
interface HeldEntry {
  readonly handle: SharedHandle;
  refs: number;
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
      sync: (deadlineMs, options) => this.sync(deadlineMs, options),
      probe: () => this.probe(),
      release: async () => {
        if (released) return;
        released = true;
        await releaseShared();
      },
    };
  }

  async sync(deadlineMs: number, options: SyncOptions = {}): Promise<string> {
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
    const txid = normalizeTxid(response.replicated_txid);
    if (!isReplicated(response) || txid === undefined) {
      await this.#condemn();
      throw new V3ReplicationError(
        `Litestream answered ${JSON.stringify(response)}`,
      );
    }
    let published = false;
    if (options.beforeLeaseCheck !== undefined) {
      try {
        await options.beforeLeaseCheck(txid);
        published = true;
      } catch (error) {
        throw error instanceof V3ReplicationError
          ? error
          : new V3ReplicationError(
            `the replicated state could not be published: ${messageOf(error)}`,
            { cause: error },
          );
      }
    }
    // The lease could have been taken over while the sync ran: a fenced
    // writer reports nothing as replicated.
    try {
      await this.assertLeaseCurrent();
    } catch (error) {
      if (!(error instanceof WriterFencedError)) {
        // Not a takeover: the lease could not be checked (swamp-club#3491).
        throw new V3ReplicationError(
          (published ? "they were published to the replica, but " : "") +
            `this process's writer lease could not be checked: ${
              messageOf(error)
            }`,
          { cause: error },
        );
      }
      if (published) {
        // The head is out: the writer that took over may restore these
        // commits, so saying nothing landed would not be true.
        const refused = new WriterFencedError(
          error.fence,
          error.currentFence,
          "published",
        );
        refused.cause = error;
        throw refused;
      }
      throw new V3ReplicationError(
        `this process lost its writer lease while the sync ran: ${
          messageOf(error)
        }`,
        { cause: error },
      );
    }
    return txid;
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

/**
 * Whether the sidecar `record` names runs on this machine, which its pids
 * are then verified on: by the supervisor's process identity, whatever the
 * hostname is now (swamp-club#3801). A record without an identity, or one
 * either side has no boot id for, by its hostname, as before.
 */
function isOwnHost(record: PresenceRecord, local: LocalProcess): boolean {
  const process = record.process;
  if (
    process !== undefined && process.bootId !== undefined &&
    local.identity.bootId !== undefined
  ) {
    return sameKernel(process, local);
  }
  return record.hostname === hostnameOf(local);
}
