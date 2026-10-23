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
  onV3HoldRetaken,
  onV3LeaseTaken,
  refuseLiveV3LegacyWriter,
  tryAcquireV3WriterLock,
  v3WriterFence,
  type V3WriterLeaseHolder,
  v3WriterLeaseHolder,
} from "./v3_writer_lock.ts";
import {
  judgeRecordedProcess,
  type LocalProcess,
  parseProcessIdentity,
  type ProcessIdentity,
} from "../../domain/datastore_v3/process_liveness.ts";
import { hostnameOf, localProcess } from "./process_identity.ts";
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
  V3LineageOutrankedError,
} from "./litestream/v3_copy.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import {
  readWriterMarkerFile,
  recoverInterruptedWriter,
  removeOwnWriterMarker,
  writerMarkerPath,
  writeWriterMarker,
} from "./interrupted_writer_recovery.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  isReservedNamespaceName,
  reservedV3NamespaceMessage,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import { assertV3CacheSubdirsContained } from "./cache_root_containment.ts";
import { recoverCommitOutbox } from "./commit_outbox_recovery.ts";
import {
  V3StorageUnreachableError,
  WriterFencedError,
} from "../../domain/datastore_v3/writer_lease.ts";
import { isNetworkFailure } from "./network_failure.ts";
import { ReadModelCatchUpUnreachableError } from "../../domain/datastore_v3/read_model.ts";
import { removeStaleRunIndexes } from "../persistence/workflow_run_index.ts";
import { storageNamespaceOf } from "../../domain/datastore_v3/chunk_store.ts";
import {
  V3ChunkCollectionDeferredError,
  V3ReplicationError,
} from "../../domain/datastore_v3/litestream_replication.ts";
import { ReplicationGroupCommit } from "../../domain/datastore_v3/replication_group_commit.ts";
import type { RepositoryFactoryConfig } from "../persistence/repository_factory.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { unreadableContentLookup } from "./unreadable_content_lookup.ts";
import { assertV3CheckoutJoinable } from "./v3_checkout_join.ts";
import { v3ForeignContentFetcher } from "./v3_foreign_content.ts";
import { isChunkQuarantine } from "../../domain/datastore/datastore_storage.ts";

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

/**
 * The writer checkout this process last recorded for each datastore, by
 * resolved datastore path: which checkout, at which fence. Set once the
 * sidecar is written; a hold at the same fence for the same checkout does
 * not write it again (swamp-club#3564).
 */
const recordedCheckouts = new Map<
  string,
  { readonly repoDir: string; readonly fence: number }
>();

/** Whether the sidecar is kept current across serve's retakes. */
let retakeListening = false;

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
 *
 * `stillCurrent` is asked just before the copy is marked current: serve's
 * replacement passes it, since a retake while the restore ran may follow
 * commits the restored lineage lacks (swamp-club#3565). When it answers
 * false the copy is left not current and the result says `stale`.
 */
export async function ensureV3CopyCurrent(
  repoDir: string,
  config: V3DatastoreConfig,
  mode: "read" | "write",
  options: { readonly stillCurrent?: () => boolean } = {},
): Promise<V3CopyRefresh & { readonly stale?: true }> {
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
  const datastore = resolve(config.path);
  const copies = copiesByDatastore.get(datastore) ?? [];
  if (!copies.some((known) => known.key === key)) {
    copiesByDatastore.set(datastore, [...copies, { ...copy, key }]);
  }
  if (refresh.restored !== undefined) restoredCopies.add(key);
  // A stale restore is not marked current, but its read model is still
  // rebuilt below: the copy state already names what it restored, so a
  // later refresh may find the copy current and restore nothing.
  const stale = options.stillCurrent?.() === false;
  if (!stale) currentCopies.add(key);
  if (refresh.restored !== undefined) {
    if (refresh.restored.readModelMoved) {
      // The checkout applied commits the restore dropped or replaced: it
      // is rebuilt from the restored commits, and the files no commit owns
      // are removed, as after an interrupted writer, under the writer lease
      // so no writer materialises files meanwhile. A reader that cannot
      // take it replays the commits instead, leaving the dropped commits'
      // files until a rebuild.
      const rebuilt = handle ?? v3DatastoreFor(repoDir, config);
      const release = mode === "write"
        ? undefined
        : await tryAcquireV3WriterLock(config.path, { fenceStore: rebuilt });
      if (mode === "write" || release !== undefined) {
        try {
          await rebuilt.recoverInterruptedWriter(0);
        } catch (error) {
          if (release !== undefined) await releaseAfterFailure(release, error);
          throw error;
        }
        await release?.();
      } else {
        // The read model replays every commit from the start. Files only
        // dropped commits wrote may stay: the reset keeps the files it
        // shows present as removal candidates (swamp-club#3617), but only
        // a compacted-base load removes them, so they go only when the
        // restored store has compacted history, and then possibly by a
        // reader without the writer lease.
        rebuilt.catalogStore.invalidate();
        await rebuilt.catchUp();
      }
    } else if (handle !== undefined) {
      // An open handle's read model catches up with the restored commits.
      await handle.catchUp();
    }
  }
  return stale ? { ...refresh, stale: true } : refresh;
}

/**
 * Joins this process's hold on the writer lease of the v3 datastore `config`
 * names, waiting up to the lock timeout for another process to finish. A
 * writing command calls it before it takes any other lock, so it never
 * holds the global or a model lock while it waits for another writer.
 * Released by {@link closeV3Datastores}.
 *
 * @throws V3WriterBusyError when another process is writing
 * @throws V3StorageUnreachableError when the datastore's storage cannot be
 *   reached meanwhile (swamp-club#3802): nothing was changed yet
 */
export async function holdV3Writer(
  config: V3DatastoreConfig,
  repoDir: string,
  options: {
    /** Take the lease again once it is lost: serve's lifetime hold. */
    readonly retakeLost?: boolean;
  } = {},
): Promise<void> {
  try {
    await takeV3WriterHold(config, repoDir, options);
  } catch (error) {
    if (!(error instanceof UserError) && isNetworkFailure(error)) {
      throw new V3StorageUnreachableError(config.path, error);
    }
    throw error;
  }
}

/** {@link holdV3Writer}, before a storage failure is given its code. */
async function takeV3WriterHold(
  config: V3DatastoreConfig,
  repoDir: string,
  options: { readonly retakeLost?: boolean },
): Promise<void> {
  // Before the lease and the recovery of an interrupted writer, which
  // would meet the same checkout (swamp-club#3691).
  await refuseUnsafeV3Checkout(repoDir, config);
  // A checkout that holds records never joins (swamp-club#3690): refused
  // before the lease, which records this checkout in the datastore.
  await assertV3CheckoutJoinable(repoDir, config.namespace);
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
      await releaseAfterFailure(release, error);
      throw error;
    }
  }
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
    await recordWriterCheckout(config.path, repoDir);
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
    await releaseAfterFailure(release, error);
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
    await removeOwnWriterCheckout(config.path);
    await release();
  });
}

/**
 * Records that this process writes the checkout at `repoDir` under its
 * current hold, unless it already recorded that checkout at that fence. A
 * hold that was lost records nothing: its sidecar is the new writer's now.
 *
 * @throws WriterFencedError when the hold was lost
 */
async function recordWriterCheckout(
  datastorePath: string,
  repoDir: string,
): Promise<void> {
  assertV3WriterCurrent(datastorePath);
  const fence = v3WriterFence(datastorePath);
  if (fence === undefined) return;
  const datastore = resolve(datastorePath);
  const canonical = await canonicalPath(repoDir);
  const recorded = recordedCheckouts.get(datastore);
  if (recorded?.fence === fence && recorded.repoDir === canonical) return;
  const sidecar = writerCheckoutPath(datastorePath);
  // A bucket datastore's local root has no _control/ of its own until
  // this first write (swamp-club#3534).
  await Deno.mkdir(dirname(sidecar), { recursive: true });
  const local = await localProcess();
  await atomicWriteTextFile(
    sidecar,
    JSON.stringify({
      repoDir: canonical,
      hostname: Deno.hostname(),
      pid: local.pid,
      process: local.identity,
      fence,
    }),
  );
  recordedCheckouts.set(datastore, { repoDir: canonical, fence });
  if (!retakeListening) {
    retakeListening = true;
    // Serve's retake writes the checkout under its new fence, so readers
    // there stay out (swamp-club#3564).
    onV3HoldRetaken(async (path, retaken) => {
      const previous = recordedCheckouts.get(resolve(path));
      if (previous === undefined || previous.fence === retaken) return;
      await recordWriterCheckout(path, previous.repoDir);
    });
  }
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
    });
  } catch (error) {
    // Cut off from the storage, the recovery is retried by the next command;
    // the hold gives the failure its code (swamp-club#3802).
    if (!(error instanceof UserError) && isNetworkFailure(error)) throw error;
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
  // process's writes, so it covers them too. An unreadable one was
  // recovered above, never written over first (swamp-club#3617).
  if ((await readWriterMarkerFile(repoDir)).kind === "absent") {
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

/** What the sidecar records. Older swamps wrote no identity or fence. */
interface WriterCheckoutRecord {
  readonly repoDir: string;
  readonly hostname: string;
  readonly pid: number;
  readonly process?: ProcessIdentity;
  readonly fence?: number;
}

async function readWriterCheckout(
  datastorePath: string,
): Promise<WriterCheckoutRecord | undefined> {
  try {
    const value = JSON.parse(
      await Deno.readTextFile(writerCheckoutPath(datastorePath)),
    );
    if (
      typeof value?.repoDir !== "string" ||
      typeof value?.hostname !== "string" || !Number.isSafeInteger(value?.pid)
    ) {
      return undefined;
    }
    const process = parseProcessIdentity(value.process);
    return {
      repoDir: value.repoDir,
      hostname: value.hostname,
      pid: value.pid,
      ...(process !== undefined ? { process } : {}),
      ...(Number.isSafeInteger(value.fence) ? { fence: value.fence } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Removes the sidecar when it is still this process's record at the fence
 * it wrote it with: a writer that took over since wrote its own.
 */
async function removeOwnWriterCheckout(datastorePath: string): Promise<void> {
  const datastore = resolve(datastorePath);
  const mine = recordedCheckouts.get(datastore);
  if (mine === undefined) return;
  recordedCheckouts.delete(datastore);
  try {
    const recorded = await readWriterCheckout(datastorePath);
    if (
      recorded !== undefined && recorded.fence === mine.fence &&
      isThisProcess(recorded, await localProcess())
    ) {
      await Deno.remove(writerCheckoutPath(datastorePath));
    }
  } catch {
    // Gone already: nothing to remove.
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
 * Whether another process writes the checkout at `repoDir` under the
 * datastore's lease, so a reader there must not catch up (swamp-club#3279):
 * the sidecar names the checkout, and its fence is still the lease's
 * highest. Its writer is then protected while it runs, whatever its TTL,
 * and until a higher fence fences it when this process cannot judge it
 * (another namespace, host or boot: swamp-club#3564). A released fence
 * keeps the protection too: the commit store takes the released holder's
 * commits until a new writer raises its fence. A sidecar from a swamp
 * before identities is judged by the lease record as it was.
 */
async function anotherProcessWritesCheckout(
  repoDir: string,
  datastorePath: string,
): Promise<boolean> {
  const recorded = await readWriterCheckout(datastorePath);
  if (
    recorded === undefined || recorded.repoDir !== await canonicalPath(repoDir)
  ) {
    return false;
  }
  const local = await localProcess();
  // This process's own sidecar, known by the fence it wrote it with: never
  // judged by liveness, which may not place this process when its boot id
  // cannot be read.
  if (isOwnWriterCheckout(datastorePath, recorded, local)) return false;
  // Judged before the lease is read: a gone writer's sidecar costs no read
  // of the lease's records.
  if (!mayBeAnotherWriter(recorded, local)) return false;
  const holder = await v3WriterLeaseHolder(datastorePath);
  if (holder === null) return false;
  return recorded.fence === undefined
    ? legacyWriterWritesCheckout(recorded, holder)
    : holder.fence === recorded.fence;
}

/** Whether `recorded` is the sidecar this process wrote for its current hold. */
function isOwnWriterCheckout(
  datastorePath: string,
  recorded: WriterCheckoutRecord,
  local: LocalProcess,
): boolean {
  const mine = recordedCheckouts.get(resolve(datastorePath));
  return mine !== undefined && recorded.fence === mine.fence &&
    isThisProcess(recorded, local);
}

/**
 * Whether `recorded` names this process: by its pid and identity, whatever
 * the hostname is now (swamp-club#3801). A record without an identity, or
 * one this kernel cannot place (its boot id unreadable), by its pid and
 * hostname, as before.
 */
function isThisProcess(
  recorded: WriterCheckoutRecord,
  local: LocalProcess,
): boolean {
  if (recorded.pid !== local.pid) return false;
  const verdict = recorded.process === undefined
    ? "unknown"
    : judgeRecordedProcess(
      { pid: recorded.pid, process: recorded.process },
      local,
    );
  if (verdict !== "unknown") return verdict === "alive";
  return recorded.hostname === hostnameOf(local);
}

/**
 * Whether the sidecar may name another process that still writes: not this
 * process's own record, and, for a record with an identity, not one judged
 * gone.
 */
function mayBeAnotherWriter(
  recorded: WriterCheckoutRecord,
  local: LocalProcess,
): boolean {
  if (recorded.fence === undefined) {
    return !(recorded.pid === local.pid &&
      recorded.hostname === hostnameOf(local));
  }
  const verdict = judgeRecordedProcess(
    {
      pid: recorded.pid,
      ...(recorded.process !== undefined ? { process: recorded.process } : {}),
    },
    local,
  );
  if (verdict === "gone") return false;
  // This process's own record: it is the writer, not another.
  return !(verdict === "alive" && recorded.pid === local.pid);
}

/**
 * A sidecar from a swamp before swamp-club#3564, judged by the lease record
 * of the same process: on this host by its pid, else within its TTL.
 */
function legacyWriterWritesCheckout(
  recorded: WriterCheckoutRecord,
  holder: V3WriterLeaseHolder,
): boolean {
  const record = holder.record;
  if (
    record === undefined || record.pid !== recorded.pid ||
    record.hostname !== recorded.hostname ||
    (recorded.pid === Deno.pid && recorded.hostname === Deno.hostname())
  ) {
    return false;
  }
  if (holder.process === "gone") return false;
  return holder.process === "alive" || holder.state === "held";
}

/**
 * What `createRepositoryContext` takes to build a v3 context over the
 * datastore `config` names: the commit-log engine and the read model's
 * catalog. Catches the read model up first, so the context reads every
 * commit made before it opened.
 *
 * Its `fetchForeignContent` reads another namespace's content from that
 * namespace's cache root in the checkout (swamp-club#3691). It is marked
 * `readsSoloNamespace`, and the context builders spread this config after
 * the v2 sync service's fetcher, so it replaces that one.
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
): Promise<
  Pick<
    RepositoryFactoryConfig,
    "commitLog" | "catalogStore" | "unreadableContent" | "fetchForeignContent"
  >
> {
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
  // Before recovery and catch-up, which would write into the checkout.
  await refuseUnsafeV3Checkout(repoDir, config);
  // A checkout that holds records never joins (swamp-club#3690): refused
  // before its copy is restored or its read model opens.
  await assertV3CheckoutJoinable(repoDir, config.namespace);
  const writer = holdsV3WriterLock(config.path);
  // A reader's copy is made current first (swamp-club#3482), unless another
  // process writes this checkout: that writer keeps it current.
  if (
    !writer && v3ReplicatesAt(config.path) &&
    await anotherProcessWritesCheckout(repoDir, config.path)
  ) {
    currentCopies.add(handleKey(repoDir, config));
  } else if (!writer) {
    try {
      await ensureV3CopyCurrent(repoDir, config, "read");
    } catch (error) {
      // Cut off from the replica's storage, the reader changed nothing, and
      // the next command makes its copy current (swamp-club#3802).
      if (
        error instanceof Error && !(error instanceof UserError) &&
        isNetworkFailure(error)
      ) {
        throw new ReadModelCatchUpUnreachableError(error);
      }
      throw error;
    }
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
  const unreadableContent = unreadableContentLookup(repoDir, handle.readModel);
  return {
    commitLog: (markDirty, runRepo) =>
      handle.engineFor(markDirty, runRepo, {
        readOnly: options.readOnly === true,
      }),
    catalogStore: handle.catalogStore,
    // A read of a record the read model could not materialise fails loudly
    // (swamp-club#3617).
    unreadableContent,
    // Another namespace's row is read from its own cache root in this
    // checkout, never from this namespace's (swamp-club#3691).
    fetchForeignContent: v3ForeignContentFetcher(
      repoDir,
      config,
      unreadableContent,
    ),
  };
}

/** Error code for a v3 checkout bound to a reserved namespace. */
export const V3_RESERVED_NAMESPACE_CODE = "datastore_v3_reserved_namespace";

/**
 * Refuses a checkout the read model cannot materialise into safely
 * (swamp-club#3691): one bound to a reserved namespace, whose cache root
 * `.swamp/{namespace}/` is a directory swamp keeps its own files in, or one
 * whose materialised subdirectories link out of their cache root, where
 * every catch-up would fail.
 */
async function refuseUnsafeV3Checkout(
  repoDir: string,
  config: V3DatastoreConfig,
): Promise<void> {
  const namespace = config.namespace ?? "";
  if (namespace !== "" && isReservedNamespaceName(namespace)) {
    throw new UserError(
      reservedV3NamespaceMessage(namespace),
      V3_RESERVED_NAMESPACE_CODE,
    );
  }
  await assertV3CacheSubdirsContained(repoDir, namespace, config.directories);
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
 * The closing sync's deadline once the datastore's storage is known
 * unreachable (swamp-club#3802): what it would confirm replicates with the
 * next write in this checkout, so the command does not wait for it.
 */
export const UNREACHABLE_SYNC_DEADLINE_MS = 1_000;

/**
 * How long a closing sync runs before its storage is probed
 * (swamp-club#3802): a sync that answers sooner, as a healthy one does, is
 * never probed.
 */
export const STORAGE_PROBE_GRACE_MS = 2_000;

/**
 * How long a lease release may take once the storage is known unreachable
 * (swamp-club#3802): one that cannot finish leaves the lease to expire by
 * its TTL, as a release that fails does.
 */
export const UNREACHABLE_RELEASE_BOUND_MS = 1_000;

let teardownTiming = {
  probeGraceMs: STORAGE_PROBE_GRACE_MS,
  releaseBoundMs: UNREACHABLE_RELEASE_BOUND_MS,
};

/** Test seam: the teardown's probe grace and release bound, or the defaults. */
export function setV3TeardownTimingForTesting(
  timing: { probeGraceMs: number; releaseBoundMs: number } | undefined,
): void {
  teardownTiming = timing ?? {
    probeGraceMs: STORAGE_PROBE_GRACE_MS,
    releaseBoundMs: UNREACHABLE_RELEASE_BOUND_MS,
  };
}

/** A content hash no chunk has, for a probe that only needs an answer. */
const PROBE_HASH = "0".repeat(64);

/**
 * Watches a closing sync of `datastore` (swamp-club#3802): once it has run
 * {@link STORAGE_PROBE_GRACE_MS}, asks the datastore's storage whether a
 * chunk exists, and aborts `signal` when the storage cannot be reached, so
 * the sync is given up as a definite failure instead of waiting out its
 * deadline. `stop` ends the watch and says whether the storage was found
 * unreachable. Nothing is watched when the storage is already known
 * unreachable or the datastore has no open handle.
 */
function watchStorageDuringSync(
  datastore: string,
  handles: readonly V3Datastore[],
  known: boolean,
): { readonly signal?: AbortSignal; stop(): boolean } {
  const handle = handles.find((h) => resolve(h.datastorePath) === datastore);
  if (known || handle === undefined) return { stop: () => false };
  const controller = new AbortController();
  const probe = new AbortController();
  let found = false;
  const timer = setTimeout(() => {
    handle.storage.has(
      storageNamespaceOf(
        handle.namespace === ""
          ? SOLO_NAMESPACE
          : restoreNamespace(handle.namespace),
      ),
      [PROBE_HASH],
      probe.signal,
    ).then(
      () => {},
      (error) => {
        if (!isNetworkFailure(error)) return;
        found = true;
        controller.abort(
          new Error(
            `the datastore's storage could not be reached: ${
              errorMessage(error)
            }`,
            { cause: error },
          ),
        );
      },
    );
  }, teardownTiming.probeGraceMs);
  return {
    signal: controller.signal,
    stop: () => {
      clearTimeout(timer);
      probe.abort();
      return found;
    },
  };
}

/**
 * Runs a lease release, but waits at most
 * {@link UNREACHABLE_RELEASE_BOUND_MS} for it (swamp-club#3802): with the
 * storage unreachable it can only fail, and the lease expires by its TTL.
 * The release keeps running until the process exits; its outcome is logged.
 */
async function boundedRelease(release: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = release().catch((error) => {
    logger
      .debug`A v3 writer lease release with the storage unreachable failed; the lease expires on its own: ${error}`;
  });
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger
        .debug`Not waiting for a v3 writer lease release with the storage unreachable; the lease expires on its own`;
      resolve();
    }, teardownTiming.releaseBoundMs);
  });
  try {
    await Promise.race([running, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Releases a writer lease after the work under it failed with `failure`,
 * which stays the error reported (swamp-club#3802): a release that fails too,
 * as one cut off from the storage does, is logged, and the lease expires by
 * its TTL.
 */
async function releaseAfterFailure(
  release: () => Promise<void>,
  failure: unknown,
): Promise<void> {
  try {
    await release();
  } catch (error) {
    logger
      .warn`Releasing the v3 writer lease after a failure also failed; it expires on its own: ${error} (the failure: ${failure})`;
  }
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
  storageUnreachable: boolean,
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
  if (storageUnreachable) {
    // Its replay would wait on the storage too (swamp-club#3802).
    keep("the datastore's storage could not be reached");
    return;
  }
  try {
    let outcome: "clean" | "busy" | "recovered" | undefined;
    try {
      outcome = await handle.recoverDroppedWork();
    } finally {
      // A recovery that ran, finished or not, may have rewritten run records.
      if (outcome === undefined || outcome === "recovered") {
        await removeStaleRunIndexes(checkout);
      }
    }
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
 *
 * Once the datastore's storage is known unreachable (swamp-club#3802),
 * because `options.storageUnreachable` says the command found it so or the
 * closing sync's probe finds it so, nothing waits on retries that cannot
 * succeed: compaction and the recovery of dropped work are left to the next
 * command, the closing sync gets {@link UNREACHABLE_SYNC_DEADLINE_MS}, and
 * each lease release gets {@link UNREACHABLE_RELEASE_BOUND_MS} before the
 * lease is left to expire by its TTL. It holds for this call only.
 */
export async function closeV3Datastores(
  options: { readonly storageUnreachable?: boolean } = {},
): Promise<void> {
  let unreachable = options.storageUnreachable === true;
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
  for (const handle of unreachable ? [] : handles) {
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
  const deadlineMs = unreachable
    ? UNREACHABLE_SYNC_DEADLINE_MS
    : v3SyncDeadlineMs();
  const synced = await Promise.allSettled([
    ...heldEntries.map(async ([datastore, uses]) => {
      const watch = watchStorageDuringSync(datastore, handles, unreachable);
      try {
        return await syncAndPublish(
          datastore,
          uses[0],
          handles,
          deadlineMs,
          watch.signal,
        );
      } finally {
        if (watch.stop()) unreachable = true;
      }
    }),
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
    await recoverDroppedWork(key, handle, current, unreachable);
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
    pending.map((release) => unreachable ? boundedRelease(release) : release()),
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
  signal?: AbortSignal,
): Promise<number | undefined> {
  // One at a time per datastore: serve's probe and a drain can both sync,
  // and a head taken earlier must never be published over a later one.
  const previous = publishing.get(datastore) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() =>
    syncAndPublishNow(datastore, use, handles, deadlineMs, signal)
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
  signal?: AbortSignal,
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
    await use.sync(deadlineMs, signal === undefined ? {} : { signal });
    return undefined;
  }
  // Taken before the sync: what the sync covers. A serve that lost its lease
  // meanwhile still publishes this head on its old lineage before its lease
  // check fails; it covers only commits nobody acknowledged, which a newer
  // lineage's writer ignores (`decideLocalCopy`).
  const mark = handle.commitStore.highWaterMark();
  let first = false;
  await use.sync(deadlineMs, {
    ...(signal === undefined ? {} : { signal }),
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

/** Whether this process's writer lease on `datastorePath` was taken over. */
function leaseLost(datastorePath: string): boolean {
  try {
    assertV3WriterCurrent(datastorePath);
    return false;
  } catch (error) {
    if (error instanceof WriterFencedError) return true;
    throw error;
  }
}

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
  // Each retake counts, so a replacement knows one came while it ran; the
  // fence it announced is the retake's even before the lease records it.
  let retakes = 0;
  let announced = 0;
  // A replacement asked for while one runs (swamp-club#3565): it runs again
  // once the running one settles, instead of being dropped.
  let again = false;
  const replace = (): void => {
    if (stopped) return;
    if (replacing !== undefined) {
      again = true;
      return;
    }
    const startedAt = retakes;
    const stale = () => retakes !== startedAt;
    replacing = (async () => {
      const uses = replications.get(key) ?? [];
      replications.delete(key);
      // This process's own shared hold goes first: a replacement waits for
      // the use lock exclusively.
      await Promise.allSettled(uses.map((use) => use.release()));
      // Owed until a sidecar is held again, even while serve has no lease:
      // a shutdown before then must not pass serve's commits as replicated.
      owedReplications.add(key);
      const held = v3WriterFence(datastorePath);
      if (held === undefined || stopped || stale()) return;
      // A retake's listeners run before its lease is recorded, when the
      // lease still names the lost fence.
      const fence = Math.max(held, announced);
      // A lost lease that no retake replaced yet: nothing commits on this
      // copy, and the retake asks for a replacement of its own, so none
      // restores at the lost fence meanwhile.
      if (fence === held && leaseLost(datastorePath)) return;
      // A retake may follow another writer's commits: the copy is made
      // current and the lineage prepared before the sidecar is held again,
      // as a writer's hold does (swamp-club#3482). The restore updates
      // serve's open store in place. A retake meanwhile makes what it
      // restored stale: it is not marked current, and nothing more runs
      // at this fence (swamp-club#3565).
      const refresh = await ensureV3CopyCurrent(repoDir, config, "write", {
        stillCurrent: () => !stale(),
      });
      if (refresh.stale === true || stale()) return;
      const handle = v3DatastoreFor(repoDir, config);
      if (refresh.restored !== undefined) {
        await handle.raiseWriterFence(fence);
      }
      // What a writer between serve's two holds left (swamp-club#3490).
      await recoverV3Outbox(handle, fence);
      if (stale()) return;
      await prepareV3WriterLineage(copyOf(repoDir, config), fence, {
        restored: restoredCopies.has(copyKey),
      });
      restoredCopies.delete(copyKey);
      if (stale()) return;
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
      // A newer writer started a lineage: this copy is behind it, so
      // nothing commits onto it until a replacement restores it.
      if (
        error instanceof V3ReplicationError &&
        error.cause instanceof V3LineageOutrankedError
      ) {
        currentCopies.delete(copyKey);
      }
      logger
        .warn`Replacing the Litestream sidecar of the v3 datastore at ${datastorePath} failed; the next probe retries: ${error}`;
    }).finally(() => {
      replacing = undefined;
      if (again) {
        again = false;
        replace();
      }
    });
  };
  // Runs inside the lease's renewal: it only starts the replacement. A
  // retake may follow another writer's commits, so the copy stops being
  // current at once, before the retaken lease admits a commit: nothing
  // commits onto it, nor collects its chunks, until the replacement has
  // made it current again (swamp-club#3482).
  const unsubscribe = onV3LeaseTaken((path, fence) => {
    if (resolve(path) !== key) return;
    retakes++;
    announced = Math.max(announced, fence);
    currentCopies.delete(copyKey);
    replace();
  });
  const timer = setInterval(() => {
    if (stopped || probing !== undefined || replacing !== undefined) return;
    probing = (async () => {
      const current = replications.get(key)?.[0];
      // A copy left not current (a replacement that failed after a retake)
      // is replaced as a dead sidecar is.
      if (
        current === undefined || !currentCopies.has(copyKey) ||
        !await current.probe()
      ) {
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
      // A rerun the settling replacement started before stopping was seen.
      while (replacing !== undefined) await replacing;
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
 * How many bytes of chunks each maintenance tick reads and checks before
 * its sweep, from a random shard prefix (swamp-club#3617): the only place
 * stored chunks are verified, so same-size damage is found while serve
 * runs. A CLI sweep verifies nothing, and neither does serve on bucket
 * storage: it cannot move a damaged chunk aside, so a pass there would
 * only spend reads on reporting.
 */
export const SERVE_CHUNK_VERIFY_BYTES = 64 * 1024 * 1024;

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
  /** Bytes of chunks to verify first; none unless given. */
  verifyBytes = 0,
): Promise<ChunkCollectionReport | undefined> {
  try {
    const report = await handle.collectChunks(
      AbortSignal.timeout(timeoutMs),
      ...(verifyBytes > 0 ? [{ bytes: verifyBytes }] : []),
    );
    if (report.deleted > 0) {
      logger
        .debug`Deleted ${report.deleted} unreferenced chunks of the v3 datastore at ${handle.datastorePath}`;
    }
    if (report.damaged.length > 0) {
      logger
        .warn`Found ${report.damaged.length} damaged chunks in the v3 datastore at ${handle.datastorePath}; ${
        report.damaged.filter((chunk) => chunk.referenced).length
      } of them named by commits`;
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
      await collectChunksQuietly(
        this.handle,
        SERVE_CHUNK_GC_TIMEOUT_MS,
        // Only storage that quarantines a damaged chunk is verified: the
        // filesystem's own `_blobs/` (swamp-club#3617).
        isChunkQuarantine(this.handle.storage) ? SERVE_CHUNK_VERIFY_BYTES : 0,
      );
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
