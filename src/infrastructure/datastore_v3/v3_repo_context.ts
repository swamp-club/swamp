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
 * Opens a v3 datastore for the CLI's and serve's repository contexts
 * (swamp-club#3279): the one place outside the v3 directories that builds
 * the engine. A repository context on a v3 datastore gets the commit-log
 * engine and the read model's catalog from here; every other choice follows
 * from those.
 *
 * One handle per checkout and datastore is opened per process, caught up
 * when a context opens, and closed by {@link closeV3Datastores} when the
 * process tears down. A writing context also joins the process's hold on
 * the datastore's writer lock.
 *
 * @module
 */

import { join, resolve } from "@std/path";
import {
  type FilesystemDatastoreConfig,
  resolveLockTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import {
  datastoreKeyFilter,
  openV3Datastore,
  type V3Datastore,
} from "./v3_datastore.ts";
import {
  acquireV3WriterLock,
  assertV3WriterCurrent,
  holdsV3WriterLock,
  onV3LeaseTaken,
  refuseLiveV3LegacyWriter,
  v3WriterFence,
  v3WriterLockHandle,
} from "./v3_writer_lock.ts";
import {
  acquireV3Replication,
  recordV3Lineage,
  type ReplicationHandle,
  setV3SyncDeadline,
  v3ReplicationEnabled,
  v3SyncDeadlineMs,
} from "./litestream/v3_replication.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import { isProcessGone } from "../runtime/process.ts";
import {
  type ProcessGoneProbe,
  readWriterMarker,
  recoverInterruptedWriter,
  removeOwnWriterMarker,
  writerMarkerPath,
  writeWriterMarker,
} from "./interrupted_writer_recovery.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import type { RepositoryFactoryConfig } from "../persistence/repository_factory.ts";
import { getSwampLogger } from "../logging/logger.ts";

const logger = getSwampLogger(["datastore", "v3"]);

const opened = new Map<string, V3Datastore>();

/**
 * The Litestream sidecars this process's writers hold (swamp-club#3416),
 * by datastore: synced once each at teardown, then released. Empty unless
 * replication is on.
 */
const replications = new Map<string, ReplicationHandle[]>();

/** Whether the lease listener that records replication lineages is set. */
let lineageListening = false;

/** Handles this process caught up while holding their writer lock. */
const caughtUpWriters = new WeakSet<V3Datastore>();
const releases: (() => Promise<void>)[] = [];

/**
 * Checkouts this process recovers and marks as their writer, since it last
 * closed: the first hold's recovery and marker write, which later holds
 * wait for.
 */
const markedCheckouts = new Map<string, Promise<void>>();

/** Teardown keeps the writer markers: work may still be uncommitted. */
let keepMarkers = false;

/** The liveness probe for recorded pids. */
const processGone: ProcessGoneProbe = isProcessGone;

/**
 * Tells this process's next {@link closeV3Datastores} to keep the writer
 * markers (swamp-club#3299): serve calls it when its shutdown drain leaves
 * runs that may still be writing, so the next command recovers the checkout.
 * The close resets it.
 */
export function keepV3WriterMarkers(): void {
  keepMarkers = true;
}

function handleKey(repoDir: string, config: FilesystemDatastoreConfig): string {
  return [resolve(repoDir), resolve(config.path), config.namespace ?? ""]
    .join("\0");
}

/** This process's handle on the v3 datastore `config` names for `repoDir`. */
export function v3DatastoreFor(
  repoDir: string,
  config: FilesystemDatastoreConfig,
): V3Datastore {
  if (!lineageListening) {
    // Every fence this process takes, the read-only recovery's included,
    // continues or restarts the datastore's replication lineage. It does
    // nothing while replication is off.
    lineageListening = true;
    onV3LeaseTaken(recordV3Lineage);
  }
  const key = handleKey(repoDir, config);
  let handle = opened.get(key);
  if (handle === undefined) {
    handle = openV3Datastore({
      repoDir,
      datastorePath: config.path,
      namespace: config.namespace ?? "",
      ...(config.directories !== undefined
        ? { directories: config.directories }
        : {}),
      ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
      writerFence: () => v3WriterFence(config.path),
      assertWriterCurrent: () => assertV3WriterCurrent(config.path),
    });
    opened.set(key, handle);
  }
  return handle;
}

/**
 * Joins this process's hold on the writer lease of the v3 datastore `config`
 * names, waiting up to the lock timeout for another process to finish. A
 * writing command calls it before it takes any other lock, so it never
 * holds the global or a model lock while it waits for another writer.
 * Released by {@link closeV3Datastores}.
 *
 * @throws V3WriterBusyError when another process is writing
 */
export async function holdV3Writer(
  config: FilesystemDatastoreConfig,
  repoDir: string,
  options: {
    /** Take the lease again once it is lost: serve's lifetime hold. */
    readonly retakeLost?: boolean;
  } = {},
): Promise<void> {
  // Before the handle opens: opening migrates commits.db, which a swamp from
  // before the lease, still writing, could not open again.
  await refuseLiveV3LegacyWriter(config.path);
  const release = await acquireV3WriterLock(config.path, {
    maxWaitMs: resolveLockTimeoutMs(),
    // Records the lease's fence in commits.db, so a writer that loses the
    // lease later can commit nothing (swamp-club#3359).
    fenceStore: v3DatastoreFor(repoDir, config).commitStore,
    ...(options.retakeLost === true ? { retakeLost: true } : {}),
  });
  const sidecar = writerCheckoutPath(config.path);
  const checkout = handleKey(repoDir, config);
  let marking = markedCheckouts.get(checkout);
  const marks = marking === undefined;
  if (marking === undefined) {
    // A writer that ended without tearing down left files no commit names:
    // recover them before this process writes (swamp-club#3299). Later holds
    // in this process wait for the same recovery.
    marking = recoverAndMark(config, repoDir);
    // Handled here, awaited below: a recovery that fails while the sidecar
    // write is still pending must not reject unhandled.
    marking.catch(() => {});
    markedCheckouts.set(checkout, marking);
  }
  try {
    await atomicWriteTextFile(
      sidecar,
      JSON.stringify({
        repoDir: await canonicalPath(repoDir),
        hostname: Deno.hostname(),
        pid: Deno.pid,
      }),
    );
    await marking;
    // Once the checkout is recovered and marked: a sidecar for this hold's
    // fence, when replication is on (swamp-club#3416).
    const fence = v3WriterFence(config.path);
    const replication = fence === undefined
      ? undefined
      : await acquireV3Replication(config.path, fence);
    if (replication !== undefined) {
      const datastore = resolve(config.path);
      replications.set(datastore, [
        ...(replications.get(datastore) ?? []),
        replication,
      ]);
    }
  } catch (error) {
    if (marks) {
      if (await marking.then(() => true, () => false)) {
        // The marker landed and another hold in this process may already
        // rely on it: it goes at teardown, not now.
        releases.push(async () => {
          if (!keepMarkers) {
            await removeOwnWriterMarker(repoDir).catch(() => {});
          }
        });
      } else {
        markedCheckouts.delete(checkout);
      }
    }
    await release();
    throw error;
  }
  releases.push(async () => {
    // The marker goes once every unit has ended, before the lock does. A
    // marker that cannot be removed costs one needless recovery, never the
    // lock.
    if (marks && !keepMarkers) {
      try {
        await removeOwnWriterMarker(repoDir);
      } catch (error) {
        logger
          .warn`Removing the v3 writer marker of ${repoDir} failed; the next command will run an unnecessary recovery: ${error}`;
      }
    }
    await removeOwnWriterCheckout(sidecar);
    await release();
  });
}

/**
 * Recovers the checkout's interrupted writer, then marks this process. A
 * recovery that fails names the marker, so a user can clear it when the
 * failure persists.
 */
async function recoverAndMark(
  config: FilesystemDatastoreConfig,
  repoDir: string,
): Promise<void> {
  try {
    await recoverInterruptedWriter(v3DatastoreFor(repoDir, config), repoDir, {
      holdsWriterLock: true,
      processGone,
    });
  } catch (error) {
    const markerPath = writerMarkerPath(repoDir);
    const recoveryError = markErrorPaths(
      new UserError(
        `Recovering ${repoDir} after a swamp process ended without finishing ` +
          `its v3 datastore writes failed: ${errorMessage(error)}. Fix the ` +
          `cause and run the command again. To give up the recovery and keep ` +
          `the checkout's files as they are, delete ${markerPath}.`,
      ),
      [repoDir, markerPath],
    );
    recoveryError.cause = error;
    throw recoveryError;
  }
  // A marker that is left stays: another host's, or a still-running
  // process's, whose writer may yet leave uncommitted files, or this
  // process's own from before a kept close. Its start is no later than this
  // process's writes, so it covers them too.
  if (await readWriterMarker(repoDir) === undefined) {
    await writeWriterMarker(repoDir);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Which checkout this datastore's writer process writes, beside its writer
 * lock (swamp-club#3279). A reader in that same checkout must not catch up
 * while the writer runs: the writer's files there are newer than its last
 * commit, and replaying older commits over them would undo its work.
 */
function writerCheckoutPath(datastorePath: string): string {
  return join(datastorePath, "_control", "writer.checkout.json");
}

async function removeOwnWriterCheckout(path: string): Promise<void> {
  try {
    const recorded = JSON.parse(await Deno.readTextFile(path));
    if (recorded?.pid === Deno.pid && recorded?.hostname === Deno.hostname()) {
      await Deno.remove(path);
    }
  } catch {
    // Gone already, or another writer's: either way not ours to remove.
  }
}

/** `path` with symlinks resolved, so two spellings of a checkout compare equal. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Whether another process on this host holds the datastore's writer lock and
 * writes the checkout at `repoDir`.
 */
async function anotherProcessWritesCheckout(
  repoDir: string,
  datastorePath: string,
): Promise<boolean> {
  let recorded: { repoDir?: string; hostname?: string; pid?: number };
  try {
    recorded = JSON.parse(
      await Deno.readTextFile(writerCheckoutPath(datastorePath)),
    );
  } catch {
    return false;
  }
  if (
    recorded.repoDir !== await canonicalPath(repoDir) ||
    recorded.hostname !== Deno.hostname() || recorded.pid === Deno.pid
  ) {
    return false;
  }
  const holder = await v3WriterLockHandle(datastorePath).inspect();
  if (
    holder === null || holder.pid !== recorded.pid ||
    holder.hostname !== Deno.hostname()
  ) {
    return false;
  }
  // A holder on this host whose process is gone writes nothing, whatever
  // its TTL says (swamp-club#3299).
  if (processGone(recorded.pid)) return false;
  return Date.parse(holder.acquiredAt) + holder.ttlMs >= Date.now();
}

/**
 * What `createRepositoryContext` takes to build a v3 context over the
 * datastore `config` names: the commit-log engine and the read model's
 * catalog. Catches the read model up first, so the context reads every
 * commit made before it opened.
 */
export async function v3RepositoryFactoryConfig(
  repoDir: string,
  config: FilesystemDatastoreConfig,
  options: {
    /** The repo keeps its definitions in the datastore's config tier. */
    readonly managedConfig?: boolean;
    /**
     * A read-only command's context: it takes no writer lock, and any change
     * staged through it is refused.
     */
    readonly readOnly?: boolean;
  } = {},
): Promise<Pick<RepositoryFactoryConfig, "commitLog" | "catalogStore">> {
  if (
    options.managedConfig === true &&
    !datastoreKeyFilter(config.directories, config.exclude)(
      "config/upstream_extensions.json",
    )
  ) {
    throw new UserError(
      "managedConfig needs the datastore's config tier, but the datastore's " +
        "`directories` or `exclude` leave `config` out, so nothing in it " +
        "would be committed. Add `config` to `directories`, or turn " +
        "managedConfig off.",
    );
  }
  const handle = v3DatastoreFor(repoDir, config);
  // In the checkout another process is writing, its files are already the
  // newest: catching up would replay older commits over them. A writing
  // process catches up once: after that its own files are the newest too,
  // and a context it opens mid-command must not replay a commit over a file
  // it has rewritten since.
  const writer = holdsV3WriterLock(config.path);
  if (!writer) {
    // A read-only command recovers a checkout whose writer ended without
    // tearing down, when it can take the writer lock (swamp-club#3299). A
    // recovery that fails leaves the marker for the next command, and the
    // read goes on.
    try {
      await recoverInterruptedWriter(handle, repoDir, {
        holdsWriterLock: false,
        processGone,
      });
    } catch (error) {
      logger
        .warn`Recovering ${repoDir} after an interrupted v3 writer failed; the next command retries: ${error}`;
    }
  }
  if (writer && caughtUpWriters.has(handle)) {
    // Caught up when this process's first context opened.
  } else if (!await anotherProcessWritesCheckout(repoDir, config.path)) {
    await handle.catchUp();
    if (writer) caughtUpWriters.add(handle);
  }
  return {
    commitLog: (markDirty, runRepo) =>
      handle.engineFor(markDirty, runRepo, {
        readOnly: options.readOnly === true,
      }),
    catalogStore: handle.catalogStore,
  };
}

/**
 * Closes every v3 datastore handle this process opened and releases its
 * writer-lock holds. Idempotent; the CLI calls it at teardown on every
 * outcome, and serve when it stops.
 */
export async function closeV3Datastores(): Promise<void> {
  const pending = releases.splice(0);
  markedCheckouts.clear();
  const handles = [...opened.values()];
  opened.clear();
  // A writer folds history the policy no longer retains before it lets go
  // of the lock: compaction is the single writer's (swamp-club#3258).
  for (const handle of handles) {
    if (holdsV3WriterLock(handle.datastorePath)) await compactQuietly(handle);
  }
  // One sync per datastore confirms every commit this process made,
  // compaction's included (swamp-club#3416). It comes before the stores
  // close: it makes Litestream open commits.db, so swamp's close is not the
  // last one and the WAL survives for the next sidecar start.
  const held = [...replications.values()];
  replications.clear();
  const synced = await Promise.allSettled(
    held.map((uses) => uses[0].sync(v3SyncDeadlineMs())),
  );
  setV3SyncDeadline(undefined);
  // Close before releasing, so no other writer starts while this process
  // still has the commit log open.
  const closed = await Promise.allSettled(
    handles.map((handle) => handle.close()),
  );
  // The sidecars go after the stores, the lease after the sidecars.
  const unheld = await Promise.allSettled(
    held.flat().map((use) => use.release()),
  );
  const released = await Promise.allSettled(
    pending.map((release) => release()),
  );
  keepMarkers = false;
  // A replication failure comes first: it is what the command reports.
  const failed = [...synced, ...closed, ...unheld, ...released].find((
    result,
  ) => result.status === "rejected");
  if (failed !== undefined && failed.status === "rejected") {
    throw failed.reason;
  }
}

/** How often serve checks that its Litestream sidecar still answers. */
export const SERVE_REPLICATION_PROBE_INTERVAL_MS = 30_000;

/** Serve's upkeep of its Litestream sidecar; see {@link startV3ReplicationUpkeep}. */
export interface V3ReplicationUpkeep {
  /** Stops the triggers and waits for a replacement in flight. */
  stop(): Promise<void>;
}

/**
 * Keeps serve's Litestream sidecar for the datastore at `datastorePath`
 * (swamp-club#3416) while serve holds its writer lease. Two triggers replace
 * it: serve retaking the lease at a new fence, which may start a new
 * lineage, and a probe that finds the sidecar no longer answering. Both go
 * through one replacement at a time, which {@link V3ReplicationUpkeep.stop}
 * awaits; none starts once stopping has begun. Does nothing while
 * replication is off.
 */
export function startV3ReplicationUpkeep(
  datastorePath: string,
  options: { readonly probeIntervalMs?: number } = {},
): V3ReplicationUpkeep {
  if (!v3ReplicationEnabled()) return { stop: () => Promise.resolve() };
  const key = resolve(datastorePath);
  let stopped = false;
  let replacing: Promise<void> | undefined;
  let probing: Promise<void> | undefined;
  const replace = (): void => {
    if (stopped || replacing !== undefined) return;
    replacing = (async () => {
      const uses = replications.get(key) ?? [];
      replications.delete(key);
      // This process's own shared hold goes first: a replacement waits for
      // the use lock exclusively.
      await Promise.allSettled(uses.map((use) => use.release()));
      const fence = v3WriterFence(datastorePath);
      if (fence === undefined || stopped) return;
      const next = await acquireV3Replication(datastorePath, fence);
      if (next !== undefined) replications.set(key, [next]);
    })().catch((error) => {
      logger
        .warn`Replacing the Litestream sidecar of the v3 datastore at ${datastorePath} failed; the next probe retries: ${error}`;
    }).finally(() => {
      replacing = undefined;
    });
  };
  // Runs inside the lease's renewal: it only starts the replacement.
  const unsubscribe = onV3LeaseTaken((path) => {
    if (resolve(path) === key) replace();
  });
  const timer = setInterval(() => {
    if (stopped || probing !== undefined || replacing !== undefined) return;
    probing = (async () => {
      const current = replications.get(key)?.[0];
      if (current === undefined || !await current.probe()) replace();
    })().catch((error) => {
      logger.debug`Probing the Litestream sidecar failed: ${error}`;
    }).finally(() => {
      probing = undefined;
    });
  }, options.probeIntervalMs ?? SERVE_REPLICATION_PROBE_INTERVAL_MS);
  Deno.unrefTimer(timer);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      await probing;
      await replacing;
    },
  };
}

/** How long a writer's closing compaction may run. */
const CLOSING_COMPACTION_TIMEOUT_MS = 60_000;

/**
 * Runs `handle`'s due compaction, logging rather than throwing a failure:
 * the command's own work is already committed, and the next writer
 * compacts again.
 */
export async function compactQuietly(handle: V3Datastore): Promise<void> {
  try {
    const report = await handle.compactIfDue(
      AbortSignal.timeout(CLOSING_COMPACTION_TIMEOUT_MS),
    );
    if (report !== undefined) {
      logger
        .debug`Compacted ${report.compacted} commits of the v3 datastore at ${handle.datastorePath}`;
    }
  } catch (error) {
    logger
      .warn`Compacting the v3 datastore at ${handle.datastorePath} failed; the next writer retries: ${error}`;
  }
}

/** How often serve maintains a v3 datastore it writes. */
export const SERVE_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/** How long one chunk sweep in serve may run. */
const SERVE_CHUNK_GC_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Sweeps `handle`'s unreferenced chunks, logging rather than throwing a
 * failure: the next sweep retries.
 */
export async function collectChunksQuietly(handle: V3Datastore): Promise<void> {
  try {
    const report = await handle.collectChunks(
      AbortSignal.timeout(SERVE_CHUNK_GC_TIMEOUT_MS),
    );
    if (report.deleted > 0) {
      logger
        .debug`Deleted ${report.deleted} unreferenced chunks of the v3 datastore at ${handle.datastorePath}`;
    }
  } catch (error) {
    logger
      .warn`Collecting chunks of the v3 datastore at ${handle.datastorePath} failed; the next sweep retries: ${error}`;
  }
}

/**
 * Makes the read model's unsynced files durable and clears its list
 * (swamp-club#3416), logging rather than throwing a failure: the next tick
 * retries, and the reboot check still covers the files.
 */
export async function syncUnsyncedQuietly(handle: V3Datastore): Promise<void> {
  try {
    const synced = await handle.readModel.syncUnsyncedFiles();
    if (synced > 0) {
      logger
        .debug`Synced ${synced} files the read model of the v3 datastore at ${handle.datastorePath} wrote unsynced`;
    }
  } catch (error) {
    logger
      .warn`Syncing the read model's unsynced files of the v3 datastore at ${handle.datastorePath} failed; the next tick retries: ${error}`;
  }
}

/**
 * Maintains a v3 datastore on a timer while serve holds its writer lock
 * (swamp-club#3279): history compaction, then chunk garbage collection, so
 * the chunks compaction frees are reclaimed while serve runs. A CLI
 * `swamp datastore gc` cannot run then: serve holds the lock. Runs never
 * overlap, and {@link stop} waits for the one in flight.
 */
export class V3MaintenanceTimer {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(
    private readonly handle: V3Datastore,
    private readonly intervalMs: number = SERVE_MAINTENANCE_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.tick(), this.intervalMs);
    Deno.unrefTimer(this.#timer);
    // Files an earlier serve left unsynced are made durable at once, not an
    // interval later.
    this.#running ??= syncUnsyncedQuietly(this.handle).finally(() => {
      this.#running = undefined;
    });
  }

  /** One timer tick: starts a maintenance run unless one is still running. */
  tick(): void {
    if (this.#running !== undefined) return;
    this.#running = (async () => {
      await compactQuietly(this.handle);
      await collectChunksQuietly(this.handle);
      await syncUnsyncedQuietly(this.handle);
    })().finally(() => {
      this.#running = undefined;
    });
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
