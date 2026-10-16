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

import { dirname, join, resolve } from "@std/path";
import {
  type DatastoreConfig,
  type FilesystemDatastoreConfig,
  isCustomDatastoreConfig,
  resolveLockTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import {
  bindV3BucketDatastore,
  boundV3BucketLocation,
  v3BucketBindingAt,
  v3BucketNamespacedStore,
  type V3DatastoreLocation,
  v3ReplicatesAt,
} from "./v3_datastore_binding.ts";
import type { WritableDatastoreControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { resolveCustomProvider } from "../persistence/datastore_global_lock.ts";
import {
  datastoreKeyFilter,
  openV3Datastore,
  v3CommitsDbPath,
  type V3Datastore,
} from "./v3_datastore.ts";
import {
  compactionBound,
  DEFAULT_COMPACTION_POLICY,
} from "../../domain/datastore_v3/compaction_policy.ts";
import type { ChunkCollectionReport } from "../../domain/datastore_v3/chunk_collector.ts";
import {
  acquireV3WriterLock,
  assertV3WriterCurrent,
  holdsV3WriterLock,
  onV3LeaseTaken,
  refuseLiveV3LegacyWriter,
  tryAcquireV3WriterLock,
  v3WriterFence,
  v3WriterLockHandle,
} from "./v3_writer_lock.ts";
import {
  acquireV3Replication,
  type ReplicationHandle,
  setV3SyncDeadline,
  v3RequestSyncDeadlineMs,
  v3SyncDeadlineMs,
} from "./litestream/v3_replication.ts";
import {
  assertV3ChunksCollectable,
  collectV3Lineages,
  makeV3CopyCurrent,
  prepareV3WriterLineage,
  publishV3Head,
  recordV3LeaseFence,
  type V3Copy,
  type V3CopyRefresh,
} from "./litestream/v3_copy.ts";
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
import { recoverCommitOutbox } from "./commit_outbox_recovery.ts";
import { WriterFencedError } from "../../domain/datastore_v3/writer_lease.ts";
import {
  V3ChunkCollectionDeferredError,
  V3ReplicationError,
} from "../../domain/datastore_v3/litestream_replication.ts";
import { ReplicationGroupCommit } from "../../domain/datastore_v3/replication_group_commit.ts";
import type { RepositoryFactoryConfig } from "../persistence/repository_factory.ts";
import { getSwampLogger } from "../logging/logger.ts";

const logger = getSwampLogger(["datastore", "v3"]);

export { v3ReplicatesAt };

/**
 * The v3 datastore a context opens: a filesystem datastore's config, or a
 * bucket datastore's location (`bindV3BucketDatastore`, swamp-club#3534).
 * Only its path, namespace and layout are read.
 */
export type V3DatastoreConfig = V3DatastoreLocation | FilesystemDatastoreConfig;

/**
 * What the v3 helpers open for the v3 datastore `config` names: a
 * filesystem datastore's config as it is, or a bucket datastore's location,
 * bound once per config object (swamp-club#3534). Call it only for a config
 * the format guard opened as v3.
 *
 * @throws V3HostingUnsupportedError, or UserError when replication is
 *   unavailable here or the provider refuses its replica target
 */
export async function v3DatastoreConfigOf(
  repoDir: string,
  config: DatastoreConfig,
): Promise<V3DatastoreConfig> {
  if (!isCustomDatastoreConfig(config)) return config;
  return boundV3BucketLocation(config) ??
    bindV3BucketDatastore(repoDir, config, await resolveCustomProvider(config));
}

/**
 * The control plane the namespaced records of the bucket datastore at
 * `location` live in (signal waits, retention watermarks), or undefined for
 * a filesystem datastore, which keeps them under its own path.
 */
export function v3BucketNamespacedStoreAt(
  location: V3DatastoreConfig,
): WritableDatastoreControlPlaneStore | undefined {
  const binding = v3BucketBindingAt(location.path);
  return binding === undefined
    ? undefined
    : v3BucketNamespacedStore(binding, location.namespace);
}

const opened = new Map<string, V3Datastore>();

/**
 * The Litestream sidecars this process's writers hold (swamp-club#3416),
 * by datastore: synced once each at teardown, then released. Empty unless
 * replication is on.
 */
const replications = new Map<string, ReplicationHandle[]>();

/**
 * Datastores whose sidecar serve released and could not get back: their
 * commits since then are unconfirmed, so the closing sync must not pass
 * silently.
 */
const owedReplications = new Set<string>();

/**
 * Whether the command's own commits were confirmed replicated after its
 * action returned ({@link confirmV3CommandReplicated}). A closing sync that
 * fails after that covers only commits made since (the end-of-command
 * retention pass's), which never fail the command (swamp-club#3534).
 */
let commandConfirmed = false;

/** Whether the lease listener that records replication lineages is set. */
let lineageListening = false;

/**
 * The checkouts' copies this process made current (swamp-club#3482), by
 * handle key: while replicating, a handle opens only on one of them.
 */
const currentCopies = new Set<string>();

/** The copies this process restored, so their writers restart a lineage. */
const restoredCopies = new Set<string>();

/**
 * The copies this process has used, by datastore, with their handle keys:
 * kept across teardowns, so a later lease in the process still finds its
 * copy's lineage.
 */
const copiesByDatastore = new Map<
  string,
  (V3Copy & { readonly key: string })[]
>();

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

/**
 * Checkouts, by resolved path, whose teardown keeps the writer marker
 * because their dropped work was not recovered (swamp-club#3553): the next
 * command recovers them. The close resets it.
 */
const keptMarkers = new Set<string>();

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

function handleKey(repoDir: string, config: V3DatastoreConfig): string {
  return [resolve(repoDir), resolve(config.path), config.namespace ?? ""]
    .join("\0");
}

/** This process's handle on the v3 datastore `config` names for `repoDir`. */
export function v3DatastoreFor(
  repoDir: string,
  config: V3DatastoreConfig,
): V3Datastore {
  if (!lineageListening) {
    // A fence this process takes outside a writer's hold (the read-only
    // recovery, serve's retake) continues the copy's lineage when it may
    // (swamp-club#3482); a writer prepares its own once its copy is
    // current. It does nothing while replication is off.
    lineageListening = true;
    onV3LeaseTaken(async (path, fence) => {
      // Safe before the copy is current: a lineage continues only while
      // no other writer started one since.
      for (const copy of copiesByDatastore.get(resolve(path)) ?? []) {
        await recordV3LeaseFence(copy, fence);
      }
      // Serve's retake of a lost hold recovers what a writer between its
      // two holds left (swamp-club#3490). Its first hold recovers in
      // recoverAndMark; while replicating, the sidecar upkeep recovers once
      // the copy is current again; a read-only hold never recovers.
      if (v3ReplicatesAt(path) || !holdsV3WriterLock(path)) return;
      for (const [key, handle] of opened) {
        if (
          resolve(handle.datastorePath) === resolve(path) &&
          markedCheckouts.has(key)
        ) {
          await recoverV3Outbox(handle, fence);
        }
      }
    });
  }
  const key = handleKey(repoDir, config);
  let handle = opened.get(key);
  if (handle === undefined) {
    if (v3ReplicatesAt(config.path) && !currentCopies.has(key)) {
      throw markErrorPaths(
        new Error(
          `Internal error: the copy of the v3 datastore at ${config.path} ` +
            `for ${repoDir} was opened before it was made current; call ` +
            `ensureV3CopyCurrent first`,
        ),
        [config.path, repoDir],
      );
    }
    handle = openV3Datastore({
      repoDir,
      datastorePath: config.path,
      namespace: config.namespace ?? "",
      ...(config.directories !== undefined
        ? { directories: config.directories }
        : {}),
      ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
      writerFence: () => v3WriterFence(config.path),
      assertWriterCurrent: () => {
        assertV3WriterCurrent(config.path);
        // While replicating, nothing commits onto a copy that is not current
        // (swamp-club#3482): after serve's retake, until its restore lands.
        if (v3ReplicatesAt(config.path) && !currentCopies.has(key)) {
          throw new WriterFencedError(
            v3WriterFence(config.path),
            undefined,
            "copy-restoring",
          );
        }
      },
      assertCopyCurrent: () => {
        // A lost hold is no lease: its copy may lack the new writer's
        // commits, whose chunks a collection would delete.
        assertV3WriterCurrent(config.path);
        if (
          v3ReplicatesAt(config.path) &&
          (!currentCopies.has(key) || !holdsV3WriterLock(config.path))
        ) {
          throw markErrorPaths(
            new Error(
              `Internal error: chunks of the v3 datastore at ${config.path} ` +
                `are collected only from a copy made current under the ` +
                `writer lease`,
            ),
            [config.path],
          );
        }
      },
      // Nor while another copy may still restore a lineage that names
      // chunks this copy does not (swamp-club#3491), nor before what this
      // copy holds is replicated (swamp-club#3534).
      assertCollectable: async () => {
        await assertV3ChunksCollectable(copyOf(repoDir, config));
        if (v3ReplicatesAt(config.path)) {
          await assertSweepReplicated(config.path, opened.get(key));
        }
      },
    });
    opened.set(key, handle);
  }
  return handle;
}

/**
 * Refuses a chunk sweep on a replicating datastore until everything the
 * copy holds is replicated (swamp-club#3534): a sweep deletes the chunks the
 * copy's commits released, compaction's included, and a restore of the
 * replica must never name one it deleted. So the sweep runs only after a
 * sync that resolves after the pass's compaction, and only while no commit
 * landed since: the high-water mark is read before the sync and again after
 * it. Compaction comes before the sweep in every pass, so a pass whose sync
 * failed sweeps nothing.
 *
 * @throws V3ChunkCollectionDeferredError when the sweep must wait
 */
async function assertSweepReplicated(
  datastorePath: string,
  handle: V3Datastore | undefined,
): Promise<void> {
  const datastore = resolve(datastorePath);
  const until = "after the next sync that confirms this copy's commits";
  const use = replications.get(datastore)?.[0];
  if (handle === undefined || use === undefined) {
    throw new V3ChunkCollectionDeferredError(
      datastorePath,
      "no Litestream sidecar is held to confirm this copy's commits",
      until,
    );
  }
  const before = handle.commitStore.highWaterMark().cursor;
  try {
    await syncAndPublish(datastore, use, [handle], v3SyncDeadlineMs());
  } catch (error) {
    throw new V3ChunkCollectionDeferredError(
      datastorePath,
      `this copy's commits are not confirmed replicated (${
        errorMessage(error)
      })`,
      until,
    );
  }
  if (handle.commitStore.highWaterMark().cursor !== before) {
    throw new V3ChunkCollectionDeferredError(
      datastorePath,
      "a commit landed while this copy's commits were being confirmed",
      until,
    );
  }
}

/** The checkout's copy of the datastore `config` names. */
function copyOf(repoDir: string, config: { readonly path: string }): V3Copy {
  return {
    datastorePath: config.path,
    repoDir,
    commitsDb: v3CommitsDbPath(config.path, repoDir),
  };
}

/**
 * Makes the checkout's copy of the datastore `config` names current before
 * this process reads or writes it (swamp-club#3482): restores it from the
 * published lineage when it is missing, behind or holds another lineage.
 * Once per process for a reader; a writer's hold and serve's retake make it
 * current again. Does nothing while replication is off.
 */
export async function ensureV3CopyCurrent(
  repoDir: string,
  config: V3DatastoreConfig,
  mode: "read" | "write",
): Promise<V3CopyRefresh> {
  const key = handleKey(repoDir, config);
  if (!v3ReplicatesAt(config.path)) {
    currentCopies.add(key);
    return {};
  }
  if (mode === "read" && currentCopies.has(key)) return {};
  // The handle's directory: the copy lives under the checkout's .swamp/.
  await Deno.mkdir(resolve(repoDir), { recursive: true });
  const copy = copyOf(repoDir, config);
  const handle = opened.get(key);
  const refresh = await makeV3CopyCurrent(copy, {
    mode,
    ...(handle !== undefined ? { openStore: handle.commitStore } : {}),
    lockWaitMs: resolveLockTimeoutMs(),
  });
  currentCopies.add(key);
  const datastore = resolve(config.path);
  const copies = copiesByDatastore.get(datastore) ?? [];
  if (!copies.some((known) => known.key === key)) {
    copiesByDatastore.set(datastore, [...copies, { ...copy, key }]);
  }
  if (refresh.restored !== undefined) {
    restoredCopies.add(key);
    if (refresh.restored.readModelMoved) {
      // The checkout applied commits the restore dropped or replaced: it
      // is rebuilt from the restored commits, and the files no commit owns
      // are removed, as after an interrupted writer, under the writer lease
      // so no writer materialises files meanwhile. A reader that cannot
      // take it replays the commits instead, leaving the dropped commits'
      // files until a rebuild.
      const rebuilt = v3DatastoreFor(repoDir, config);
      const release = mode === "write"
        ? undefined
        : await tryAcquireV3WriterLock(config.path, { fenceStore: rebuilt });
      if (mode === "write" || release !== undefined) {
        try {
          await rebuilt.recoverInterruptedWriter(0);
        } finally {
          await release?.();
        }
      } else {
        // The read model replays every commit from the start; only files
        // of dropped commits may stay until then.
        rebuilt.catalogStore.invalidate();
        await rebuilt.catchUp();
      }
    } else if (handle !== undefined) {
      // An open handle's read model catches up with the restored commits.
      await handle.catchUp();
    }
  }
  return refresh;
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
  config: V3DatastoreConfig,
  repoDir: string,
  options: {
    /** Take the lease again once it is lost: serve's lifetime hold. */
    readonly retakeLost?: boolean;
  } = {},
): Promise<void> {
  // Before the handle opens: opening migrates commits.db, which a swamp from
  // before the lease, still writing, could not open again.
  await refuseLiveV3LegacyWriter(config.path);
  const key = handleKey(repoDir, config);
  const release = await acquireV3WriterLock(config.path, {
    maxWaitMs: resolveLockTimeoutMs(),
    // Records the lease's fence in commits.db, so a writer that loses the
    // lease later can commit nothing (swamp-club#3359). While replicating,
    // the copy is opened only once it is current, and the first fence is
    // raised then (swamp-club#3482); a retake raises it here.
    fenceStore: {
      writerFence: () =>
        !v3ReplicatesAt(config.path) || currentCopies.has(key)
          ? v3DatastoreFor(repoDir, config).commitStore.writerFence()
          : undefined,
      raiseWriterFence: async (fence: number) => {
        if (!v3ReplicatesAt(config.path) || currentCopies.has(key)) {
          await v3DatastoreFor(repoDir, config).raiseWriterFence(fence);
        }
      },
    },
    ...(options.retakeLost === true ? { retakeLost: true } : {}),
  });
  if (v3ReplicatesAt(config.path)) {
    try {
      // The lease first, then the restore: every commit the previous writer
      // acknowledged is in what this one restores (swamp-club#3482).
      await ensureV3CopyCurrent(repoDir, config, "write");
      const fence = v3WriterFence(config.path);
      if (fence !== undefined) {
        await v3DatastoreFor(repoDir, config).raiseWriterFence(fence);
      }
    } catch (error) {
      await release();
      throw error;
    }
  }
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
    // A bucket datastore's local root has no _control/ of its own until
    // this first write (swamp-club#3534).
    await Deno.mkdir(dirname(sidecar), { recursive: true });
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
    if (fence !== undefined && v3ReplicatesAt(config.path)) {
      await prepareV3WriterLineage(copyOf(repoDir, config), fence, {
        restored: restoredCopies.has(key),
      });
      restoredCopies.delete(key);
    }
    const replication = fence === undefined
      ? undefined
      : await acquireV3Replication(
        v3DatastoreFor(repoDir, config).commitsDbPath,
        config.path,
        fence,
      );
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
          if (!keepsMarker(repoDir)) {
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
    if (marks && !keepsMarker(repoDir)) {
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
  config: V3DatastoreConfig,
  repoDir: string,
): Promise<void> {
  // What a writer that died left in the outbox lands first, so the
  // interrupted-writer recovery keeps the files its commits own
  // (swamp-club#3490). Its failures name the outbox, not the marker.
  const handle = v3DatastoreFor(repoDir, config);
  const fence = v3WriterFence(config.path);
  if (fence !== undefined) await recoverV3Outbox(handle, fence);
  try {
    await recoverInterruptedWriter(handle, repoDir, {
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

/**
 * The fence each commit store's outbox was last recovered at in this
 * process, by `commits.db` path: a writer recovers once per fence it takes.
 */
const outboxRecoveredAt = new Map<string, number>();

/**
 * Lands, settles or drops what the outbox of `handle`'s commit store holds
 * (swamp-club#3490), under the writer lease at `fence`. Once per fence per
 * store: checkouts sharing the datastore's `commits.db` share its outbox.
 */
async function recoverV3Outbox(
  handle: V3Datastore,
  fence: number,
): Promise<void> {
  const store = resolve(handle.commitsDbPath);
  if (outboxRecoveredAt.get(store) === fence) return;
  await recoverCommitOutbox(handle, { fence, writer: handle.writer });
  outboxRecoveredAt.set(store, fence);
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
  config: V3DatastoreConfig,
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
  const writer = holdsV3WriterLock(config.path);
  // A reader's copy is made current first (swamp-club#3482), unless another
  // process writes this checkout: that writer keeps it current.
  if (
    !writer && v3ReplicatesAt(config.path) &&
    await anotherProcessWritesCheckout(repoDir, config.path)
  ) {
    currentCopies.add(handleKey(repoDir, config));
  } else if (!writer) {
    await ensureV3CopyCurrent(repoDir, config, "read");
  }
  const handle = v3DatastoreFor(repoDir, config);
  // In the checkout another process is writing, its files are already the
  // newest: catching up would replay older commits over them. A writing
  // process catches up once: after that its own files are the newest too,
  // and a context it opens mid-command must not replay a commit over a file
  // it has rewritten since.
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

/** Whether teardown keeps the writer marker of the checkout at `repoDir`. */
function keepsMarker(repoDir: string): boolean {
  return keepMarkers || keptMarkers.has(resolve(repoDir));
}

/**
 * Whether this process still writes the datastore of the handle at `key`:
 * it holds a current writer lease, and while replicating its copy is
 * current. Only then may it rebuild the checkout.
 */
function writesCurrentCopy(key: string, handle: V3Datastore): boolean {
  if (!holdsV3WriterLock(handle.datastorePath)) return false;
  try {
    assertV3WriterCurrent(handle.datastorePath);
  } catch {
    return false;
  }
  // A takeover the renewal has not noticed yet shows in the store's fence.
  const fence = v3WriterFence(handle.datastorePath);
  const stored = handle.writerFence();
  if (stored !== undefined && (fence === undefined || stored > fence)) {
    return false;
  }
  return !v3ReplicatesAt(handle.datastorePath) || currentCopies.has(key);
}

/**
 * Recovers the work a checkout's units dropped (swamp-club#3553) before the
 * command ends, with the swamp-club#3299 recovery. A process that lost its
 * lease, a checkout with a unit still open, or a recovery that fails keeps
 * the writer marker instead, so the next command in the checkout recovers.
 * Never fails the teardown.
 */
async function recoverDroppedWork(
  key: string,
  handle: V3Datastore,
  current: boolean,
): Promise<void> {
  const checkout = key.split("\0")[0];
  const keep = (why: string): void => {
    keptMarkers.add(checkout);
    handle.forgetDroppedWork();
    logger
      .info`Work a command dropped stays in ${checkout} until the next command recovers it: ${why}`;
  };
  if (!current) {
    keep("this process no longer holds the v3 writer lease");
    return;
  }
  if (keepMarkers) {
    // Serve's drain left runs that may still be writing between units.
    keep("runs may still be writing");
    return;
  }
  try {
    const outcome = await handle.recoverDroppedWork();
    if (outcome === "busy") {
      keep(
        `${
          handle.droppedWork()?.openUnits ?? 0
        } unit(s) of work are still open`,
      );
    }
  } catch (error) {
    keep(`its recovery failed: ${errorMessage(error)}`);
  }
}

/**
 * Closes every v3 datastore handle this process opened and releases its
 * writer-lock holds. Idempotent; the CLI calls it at teardown on every
 * outcome, and serve when it stops.
 */
export async function closeV3Datastores(): Promise<void> {
  const pending = releases.splice(0);
  markedCheckouts.clear();
  const entries = [...opened.entries()];
  const handles = entries.map(([, handle]) => handle);
  opened.clear();
  // Whether each checkout that dropped work may recover it now
  // (swamp-club#3553), judged while the lease and copy state are here.
  const dropped = entries.flatMap(([key, handle]) =>
    handle.droppedWork() === undefined
      ? []
      : [{ key, handle, current: writesCurrentCopy(key, handle) }]
  );
  // A writer folds history the policy no longer retains before it lets go
  // of the lock: compaction is the single writer's (swamp-club#3258).
  for (const handle of handles) {
    if (holdsV3WriterLock(handle.datastorePath)) await compactQuietly(handle);
  }
  // One sync per datastore confirms every commit this process made,
  // compaction's included (swamp-club#3416). It comes before the stores
  // close: it makes Litestream open commits.db, so swamp's close is not the
  // last one and the WAL survives for the next sidecar start.
  const heldEntries = [...replications.entries()];
  const held = heldEntries.map(([, uses]) => uses);
  const owed = [...owedReplications].filter((key) => !replications.has(key));
  replications.clear();
  owedReplications.clear();
  const synced = await Promise.allSettled([
    ...heldEntries.map(([datastore, uses]) =>
      syncAndPublish(datastore, uses[0], handles, v3SyncDeadlineMs())
    ),
    ...owed.map((datastore) =>
      Promise.reject(
        markErrorPaths(
          new V3ReplicationError(
            `the Litestream sidecar of the v3 datastore at ${datastore} ` +
              `could not be replaced, so serve's recent commits were never ` +
              `confirmed`,
          ),
          [datastore],
        ),
      )
    ),
  ]);
  setV3SyncDeadline(undefined);
  // After the closing sync, which serve's drain deadline is for, and before
  // the stores close.
  for (const { key, handle, current } of dropped) {
    await recoverDroppedWork(key, handle, current);
  }
  // Once the command's own commits were confirmed, a closing sync that
  // fails covers only what was committed since: kept in commits.db, it
  // replicates with the next write and does not fail the command.
  const confirmedEarlier = commandConfirmed;
  commandConfirmed = false;
  const closing = synced.map((result) => {
    if (
      confirmedEarlier && result.status === "rejected" &&
      result.reason instanceof V3ReplicationError
    ) {
      logger
        .warn`Commits made after this command's own (retention, housekeeping) are not replicated yet; they are kept and replicate with the next write: ${result.reason.message}`;
      return { status: "fulfilled", value: undefined } as const;
    }
    return result;
  });
  currentCopies.clear();
  restoredCopies.clear();
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
  keptMarkers.clear();
  // A replication failure comes first: it is what the command reports.
  const failed = [...closing, ...closed, ...unheld, ...released].find((
    result,
  ) => result.status === "rejected");
  if (failed !== undefined && failed.status === "rejected") {
    throw failed.reason;
  }
}

/**
 * Syncs the sidecar `use` holds for `datastore` and, between the sync and
 * the lease check, publishes the head it confirmed (swamp-club#3482): the
 * last commit before the sync is the high-water mark. Collects the
 * lineages a first confirmation replaced once the check passed. Resolves
 * with the published head's high-water mark, or undefined when the sync
 * published no head.
 */
async function syncAndPublish(
  datastore: string,
  use: ReplicationHandle,
  handles: readonly V3Datastore[],
  deadlineMs: number,
): Promise<number | undefined> {
  // One at a time per datastore: serve's probe and a drain can both sync,
  // and a head taken earlier must never be published over a later one.
  const previous = publishing.get(datastore) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() =>
    syncAndPublishNow(datastore, use, handles, deadlineMs)
  );
  publishing.set(datastore, run);
  try {
    return await run;
  } finally {
    if (publishing.get(datastore) === run) publishing.delete(datastore);
  }
}

/** The sync-and-publish in flight, by datastore. */
const publishing = new Map<string, Promise<unknown>>();

async function syncAndPublishNow(
  datastore: string,
  use: ReplicationHandle,
  handles: readonly V3Datastore[],
  deadlineMs: number,
): Promise<number | undefined> {
  const handle = handles.find((h) => resolve(h.datastorePath) === datastore);
  const copy = handle === undefined
    ? undefined
    : (copiesByDatastore.get(datastore) ?? []).find((known) =>
      known.commitsDb === handle.commitsDbPath
    );
  const writerFence = handle === undefined
    ? undefined
    : v3WriterFence(handle.datastorePath);
  if (handle === undefined || copy === undefined || writerFence === undefined) {
    await use.sync(deadlineMs);
    return undefined;
  }
  // Taken before the sync: what the sync covers. A serve that lost its lease
  // meanwhile still publishes this head on its old lineage before its lease
  // check fails; it covers only commits nobody acknowledged, which a newer
  // lineage's writer ignores (`decideLocalCopy`).
  const mark = handle.commitStore.highWaterMark();
  let first = false;
  await use.sync(deadlineMs, {
    beforeLeaseCheck: async (txid) => {
      first = await publishV3Head(copy, {
        lineageFence: use.lineageFence,
        writerFence,
        txid,
        mark,
      });
    },
  });
  publishedMarks.set(
    datastore,
    Math.max(publishedMarks.get(datastore) ?? 0, mark.cursor),
  );
  if (first) {
    // A bucket datastore's old lineage paths go through its provider's
    // replica paths (swamp-club#3531, #3534).
    const replicaPaths = v3BucketBindingAt(datastore)?.replicaPaths;
    await collectV3Lineages(
      copy,
      use.lineageFence,
      replicaPaths !== undefined ? { replicaPaths } : {},
    );
  }
  return mark.cursor;
}

/**
 * Confirms that every commit this process made so far to each v3 datastore
 * it writes is replicated and its head published, at the CLI's closing
 * deadline (swamp-club#3534). The end-of-command retention pass calls it
 * once the command's action has returned, so every commit the command made
 * has landed: once it succeeded, the closing sync's failure covers only the
 * pass's own commits, which never fail the command. A datastore whose
 * published head already covers its commits is not synced again. Does
 * nothing for a datastore that does not replicate.
 *
 * @throws V3ReplicationError when the commits were not confirmed
 * @throws WriterFencedError when this process lost its writer lease
 */
export async function confirmV3CommandReplicated(): Promise<void> {
  const handles = [...opened.values()];
  for (const [datastore, uses] of [...replications.entries()]) {
    const handle = handles.find((h) => resolve(h.datastorePath) === datastore);
    if (
      handle !== undefined &&
      handle.commitStore.highWaterMark().cursor <=
        (publishedMarks.get(datastore) ?? -1)
    ) {
      continue;
    }
    await syncAndPublish(datastore, uses[0], handles, v3SyncDeadlineMs());
  }
  commandConfirmed = true;
}

/** Serve's group commits, by datastore (swamp-club#3489). */
const groupCommits = new Map<string, ReplicationGroupCommit>();

/**
 * Confirms that every commit this process made to the v3 datastore at
 * `datastorePath` so far is replicated and its head published, before serve
 * answers the write request that made them (swamp-club#3489). Concurrent
 * requests share syncs ({@link ReplicationGroupCommit}); a request whose
 * commits a published head already covers does not sync. Does nothing
 * while replication is off.
 *
 * @throws V3ReplicationError when the commits were not confirmed: they stay
 *   in commits.db and ship with the next sync
 * @throws WriterFencedError when serve lost its writer lease
 */
export async function confirmV3Replicated(
  datastorePath: string,
): Promise<void> {
  if (!v3ReplicatesAt(datastorePath)) return;
  const datastore = resolve(datastorePath);
  const handle = [...opened.values()].find((h) =>
    resolve(h.datastorePath) === datastore
  );
  if (handle === undefined) {
    throw new V3ReplicationError(
      `the v3 datastore at ${datastorePath} is not open in this process`,
    );
  }
  // Read after the request's commits landed: a later mark only covers more.
  const mark = handle.commitStore.highWaterMark().cursor;
  if (mark <= (publishedMarks.get(datastore) ?? -1)) return;
  let group = groupCommits.get(datastore);
  if (group === undefined) {
    group = new ReplicationGroupCommit(() => syncForRequests(datastore));
    groupCommits.set(datastore, group);
  }
  await group.confirm(mark);
}

/**
 * The high-water mark of the commits this process made to the v3 datastore
 * at `datastorePath`, or -1 when it is not open: serve reads it when a write
 * request starts, so a request that committed nothing confirms nothing.
 */
export function v3CommitMark(datastorePath: string): number {
  const datastore = resolve(datastorePath);
  const handle = [...opened.values()].find((h) =>
    resolve(h.datastorePath) === datastore
  );
  return handle?.commitStore.highWaterMark().cursor ?? -1;
}

/** One group commit's sync: the held sidecar's, at a request's deadline. */
async function syncForRequests(
  datastore: string,
): Promise<number | undefined> {
  const use = replications.get(datastore)?.[0];
  if (use === undefined) {
    // Released for a replacement, never got back, or closed: nothing can
    // confirm the commits until a sidecar is held again.
    throw new V3ReplicationError(
      `no Litestream sidecar is held for the v3 datastore at ${datastore}`,
    );
  }
  return await syncAndPublish(
    datastore,
    use,
    [...opened.values()],
    v3RequestSyncDeadlineMs(),
  );
}

/**
 * The highest high-water mark each datastore's head was published at by
 * this process, which serve's probe compares against. It is not reset when
 * serve's lineage restarts: a restarted lineage's first head is published by
 * the retake's own first sync or the next commit, and until then the
 * previous lineage stays the current state, which holds the same commits.
 */
const publishedMarks = new Map<string, number>();

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
  repoDir: string,
  config: V3DatastoreConfig,
  options: { readonly probeIntervalMs?: number } = {},
): V3ReplicationUpkeep {
  if (!v3ReplicatesAt(config.path)) return { stop: () => Promise.resolve() };
  const datastorePath = config.path;
  const key = resolve(datastorePath);
  const copyKey = handleKey(repoDir, config);
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
      // Owed until a sidecar is held again, even while serve has no lease:
      // a shutdown before then must not pass serve's commits as replicated.
      owedReplications.add(key);
      const fence = v3WriterFence(datastorePath);
      if (fence === undefined || stopped) return;
      // A retake may follow another writer's commits: the copy is made
      // current and the lineage prepared before the sidecar is held again,
      // as a writer's hold does (swamp-club#3482). The restore updates
      // serve's open store in place.
      const refresh = await ensureV3CopyCurrent(repoDir, config, "write");
      const handle = v3DatastoreFor(repoDir, config);
      if (refresh.restored !== undefined) {
        await handle.raiseWriterFence(fence);
      }
      // What a writer between serve's two holds left (swamp-club#3490).
      await recoverV3Outbox(handle, fence);
      await prepareV3WriterLineage(copyOf(repoDir, config), fence, {
        restored: restoredCopies.has(copyKey),
      });
      restoredCopies.delete(copyKey);
      const next = await acquireV3Replication(
        handle.commitsDbPath,
        datastorePath,
        fence,
      );
      if (next !== undefined) {
        // Merged: a writer hold taken meanwhile keeps its own entry, which
        // the closing teardown releases.
        replications.set(key, [...(replications.get(key) ?? []), next]);
        owedReplications.delete(key);
      }
    })().catch((error) => {
      logger
        .warn`Replacing the Litestream sidecar of the v3 datastore at ${datastorePath} failed; the next probe retries: ${error}`;
    }).finally(() => {
      replacing = undefined;
    });
  };
  // Runs inside the lease's renewal: it only starts the replacement. A
  // retake may follow another writer's commits, so the copy stops being
  // current at once, before the retaken lease admits a commit: nothing
  // commits onto it, nor collects its chunks, until the replacement has
  // made it current again (swamp-club#3482).
  const unsubscribe = onV3LeaseTaken((path) => {
    if (resolve(path) !== key) return;
    currentCopies.delete(copyKey);
    replace();
  });
  const timer = setInterval(() => {
    if (stopped || probing !== undefined || replacing !== undefined) return;
    probing = (async () => {
      const current = replications.get(key)?.[0];
      if (current === undefined || !await current.probe()) {
        replace();
        return;
      }
      // Serve's commits replicate passively; a head is published whenever
      // the last commit moved, so a takeover after serve dies keeps every
      // commit up to the last probe (swamp-club#3482).
      const handle = opened.get(copyKey);
      if (
        handle === undefined ||
        handle.commitStore.highWaterMark().cursor === publishedMarks.get(key)
      ) {
        return;
      }
      try {
        await syncAndPublish(
          key,
          current,
          [handle],
          SERVE_REPLICATION_PROBE_INTERVAL_MS,
        );
      } catch (error) {
        logger
          .warn`Publishing the replicated state of the v3 datastore at ${datastorePath} failed; the next probe retries: ${error}`;
      }
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

/** The datastores whose deferred chunk collection was logged at info. */
const deferredCollections = new Set<string>();

/**
 * Sweeps `handle`'s unreferenced chunks, logging rather than throwing a
 * failure: the next sweep retries. Resolves with the sweep's report, or
 * undefined when it failed or was deferred.
 */
export async function collectChunksQuietly(
  handle: V3Datastore,
  timeoutMs: number = SERVE_CHUNK_GC_TIMEOUT_MS,
): Promise<ChunkCollectionReport | undefined> {
  try {
    const report = await handle.collectChunks(
      AbortSignal.timeout(timeoutMs),
    );
    if (report.deleted > 0) {
      logger
        .debug`Deleted ${report.deleted} unreferenced chunks of the v3 datastore at ${handle.datastorePath}`;
    }
    return report;
  } catch (error) {
    if (error instanceof V3ChunkCollectionDeferredError) {
      // Waiting on another lineage is expected, not a failure
      // (swamp-club#3491), but it can last: said once per datastore at
      // info, so a collection that never runs can be found.
      const datastore = resolve(handle.datastorePath);
      if (deferredCollections.has(datastore)) {
        logger
          .debug`Collecting chunks of the v3 datastore at ${handle.datastorePath} still waits: ${error.message}`;
      } else {
        deferredCollections.add(datastore);
        logger
          .info`Collecting chunks of the v3 datastore at ${handle.datastorePath} waits: ${error.message}`;
      }
      return undefined;
    }
    logger
      .warn`Collecting chunks of the v3 datastore at ${handle.datastorePath} failed; the next sweep retries: ${error}`;
    return undefined;
  }
}

/** How long a retention pass's history compaction may run. */
const RETENTION_COMPACTION_TIMEOUT_MS = 10 * 60 * 1000;

/** What {@link compactRetentionQuietly} did. */
export interface RetentionCompaction {
  /**
   * Commits written before this instant are folded out of history: the
   * earlier of the retention cutoff and the 7-day safety window.
   */
  readonly bound: Date;
  /** The compaction point after it: the last commit cursor folded. */
  readonly compactedThrough: number;
  /** Commits folded by this call. */
  readonly compacted: number;
  /**
   * Chunks the sweep after it deleted; 0 when the sweep failed or was
   * deferred (logged), which the next sweep retries.
   */
  readonly chunksDeleted: number;
}

/**
 * After a retention pass on a v3 datastore (swamp-club#3473): folds every
 * commit written before `cutoff` out of history, however few, then sweeps
 * the chunks no commit names any more. Logs rather than throws a failure,
 * resolving with undefined when compaction failed; the next pass retries.
 *
 * The effective guarantee is weaker than the cutoff: the content a remove
 * took away stays in history until the remove itself is folded, and no
 * commit newer than the cutoff or inside the 7-day safety window (the
 * outbox's retry bound) is folded. A released chunk is then deleted only
 * past the sweep's 24-hour grace (`DEFAULT_CHUNK_GRACE_MS`). Content a
 * remove at time T took away is gone from the datastore at the first pass
 * after T + max(retention period, 7 days) + 24 hours, so call this on every
 * pass, not only on those that deleted something: the pass that deletes an
 * item can never fold its own remove.
 *
 * Run it only while this process holds the writer lock: compaction passes
 * the writer's fence, which the commit store checks, and the sweep refuses
 * a copy not made current under the lease.
 */
export async function compactRetentionQuietly(
  handle: V3Datastore,
  cutoff: Date,
  /**
   * How long compaction and the chunk sweep may each run; a CLI command
   * passes a short one so its exit is not held up (the next pass resumes).
   */
  timeoutMs: number = RETENTION_COMPACTION_TIMEOUT_MS,
): Promise<RetentionCompaction | undefined> {
  let compaction;
  try {
    compaction = await handle.compactBefore(
      cutoff,
      AbortSignal.timeout(timeoutMs),
    );
  } catch (error) {
    logger
      .warn`Compacting the history of the v3 datastore at ${handle.datastorePath} before the retention cutoff failed; the next pass retries: ${error}`;
    return undefined;
  }
  const compacted = compaction.report?.compacted ?? 0;
  if (compacted > 0) {
    logger
      .debug`Compacted ${compacted} commits written before ${compaction.bound.toISOString()} of the v3 datastore at ${handle.datastorePath}`;
  }
  const sweep = await collectChunksQuietly(
    handle,
    Math.min(timeoutMs, SERVE_CHUNK_GC_TIMEOUT_MS),
  );
  return {
    bound: compaction.bound,
    compactedThrough: compaction.compactedThrough,
    compacted,
    chunksDeleted: sweep?.deleted ?? 0,
  };
}

/** How far back a v3 datastore's history reaches (swamp-club#3473). */
export interface V3RetentionHistory {
  /** The write time of the oldest stored commit, or null when none is. */
  readonly oldestCommitAt: string | null;
  /**
   * Commits written before this are folded by each retention pass
   * ({@link compactRetentionQuietly} with the pass's own time): the 7-day
   * safety window always binds.
   */
  readonly compactionBound: Date;
}

/**
 * The oldest commit the v3 datastore at `config` still stores, and the bound
 * retention compacts before at `now`, for `swamp doctor datastores
 * --retention`. Read-only: call it after a repository context has made the
 * checkout's copy current.
 */
export async function v3RetentionHistory(
  repoDir: string,
  config: V3DatastoreConfig,
  now: Date,
): Promise<V3RetentionHistory> {
  const handle = v3DatastoreFor(repoDir, config);
  return {
    oldestCommitAt: await handle.commitStore.oldestStoredCommitAt(),
    compactionBound: compactionBound(DEFAULT_COMPACTION_POLICY, now, now),
  };
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

  /**
   * Runs `fn` as this timer's maintenance run, once the one in flight ends,
   * so other work on the same datastore (a retention pass's compaction and
   * chunk sweep, swamp-club#3473) never overlaps a tick: the sweep marker
   * is one row, and two sweeps at once hide a sweep from writers.
   * Ticks while `fn` runs start nothing.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.#running !== undefined) await this.#running;
    const work = fn();
    this.#running = work.then(() => {}, () => {}).finally(() => {
      this.#running = undefined;
    });
    return await work;
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
