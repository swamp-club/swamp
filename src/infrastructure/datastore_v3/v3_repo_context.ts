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
 * one handle per checkout and datastore per process, caught up when a context
 * opens and closed by closeV3Datastores at teardown; a writing context joins
 * the process's hold on the writer lock
 */

import { clearServeUnreachableLatches } from "./serve_datastore_client.ts";
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
  v3ControlPlaneAt,
  type V3DatastoreLocation,
  v3NamespacedStore,
  v3ReplicatesAt,
} from "./v3_datastore_binding.ts";
import type { WritableDatastoreControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { resolveCustomProvider } from "../persistence/datastore_global_lock.ts";
import {
  type CatchUpOptions,
  datastoreKeyFilter,
  openV3Datastore,
  v3CommitsDbPath,
  type V3Datastore,
  v3OutboxPath,
} from "./v3_datastore.ts";
import {
  compactionBound,
  DEFAULT_COMPACTION_POLICY,
} from "../../domain/datastore_v3/compaction_policy.ts";
import type { ChunkCollectionReport } from "../../domain/datastore_v3/chunk_collector.ts";
import {
  acquireV3WriterLock,
  advanceV3WriterLease,
  assertV3WriterCurrent,
  holdsCurrentV3WriterLease,
  holdsV3WriterLock,
  onV3HoldRetaken,
  onV3LeaseTaken,
  refuseLiveV3LegacyWriter,
  tryAcquireV3WriterLock,
  V3WriterBusyError,
  v3WriterFence,
  type V3WriterLeaseHolder,
  v3WriterLeaseHolder,
} from "./v3_writer_lock.ts";
import {
  peekDatastoreOwner,
  peekHighWaterCursor,
} from "./sqlite_commit_store.ts";
import { countPendingOutboxEntries } from "./sqlite_commit_outbox.ts";
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
  setV3ClosingDeadline,
  v3ClosingDeadline,
  v3RequestSyncDeadlineMs,
  v3SyncDeadlineMs,
} from "./litestream/v3_replication.ts";
import {
  assertV3ChunksCollectable,
  collectV3Lineages,
  makeV3CopyCurrent,
  prepareV3WriterLineage,
  pruneV3Heads,
  publishV3Head,
  recordV3LeaseFence,
  type V3Copy,
  type V3CopyRefresh,
  V3LineageOutrankedError,
  v3ReplicaCheckOf,
} from "./litestream/v3_copy.ts";
import { BrokenLineageMoveGuard } from "../../domain/datastore_v3/broken_lineage_move.ts";
import { isLineageBroken } from "../../domain/datastore_v3/replica_verification.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import {
  readWriterMarkerFile,
  recoverInterruptedWriter,
  recoverOwnPredecessor,
  removeOwnWriterMarker,
  writerMarkerPath,
  writeWriterMarker,
} from "./interrupted_writer_recovery.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  DatastoreClaimedError,
  type DatastoreOwner,
  normalizeOwnerAddress,
} from "../../domain/datastore_v3/datastore_owner.ts";
import {
  type ServeLeader,
  ServeNotLeaderError,
} from "../../domain/datastore_v3/serve_leader.ts";
import {
  isReservedNamespaceName,
  reservedV3NamespaceMessage,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import { assertV3CacheSubdirsContained } from "./cache_root_containment.ts";
import { recoverCommitOutbox } from "./commit_outbox_recovery.ts";
import { alignCheckoutView, checkoutViewOf } from "./checkout_view.ts";
import {
  V3StorageUnreachableError,
  WriterFencedError,
} from "../../domain/datastore_v3/writer_lease.ts";
import { isNetworkFailure } from "./network_failure.ts";
import { ReadModelCatchUpUnreachableError } from "../../domain/datastore_v3/read_model.ts";
import { removeStaleOutputSummaries } from "../persistence/output_summary_index.ts";
import { removeStaleRunIndexes } from "../persistence/workflow_run_index.ts";
import { storageNamespaceOf } from "../../domain/datastore_v3/chunk_store.ts";
import {
  V3ChunkCollectionDeferredError,
  V3ReplicationError,
  V3ReplicationUnavailableError,
} from "../../domain/datastore_v3/litestream_replication.ts";
import { ReplicationGroupCommit } from "../../domain/datastore_v3/replication_group_commit.ts";
import { HeadPublishPacer } from "../../domain/datastore_v3/head_publish_pacer.ts";
import { closeServeLockClients } from "./serve_lock.ts";
import type {
  CatchUpRequest,
  DeliveredCatchUp,
} from "./serve_datastore_client.ts";
import { abortableSleep } from "../http/rate_limit.ts";
import {
  type BucketWriteRefusal,
  withBucketWriteScope,
} from "./bucket_write_retry.ts";
import type { RepositoryFactoryConfig } from "../persistence/repository_factory.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { commandStopSignal } from "../process/shutdown_handlers.ts";
import { withSpan } from "../tracing/tracer.ts";
import { unreadableContentLookup } from "./unreadable_content_lookup.ts";
import { assertV3CheckoutJoinable } from "./v3_checkout_join.ts";
import { v3ForeignContentFetcher } from "./v3_foreign_content.ts";
import { isChunkQuarantine } from "../../domain/datastore/datastore_storage.ts";
import { serveUpstreamAt } from "./serve_upstream_registry.ts";
import { ServeUnreachableError } from "./serve_upstream_errors.ts";
import { reportQueuedOffline, resetServeOffline } from "./serve_offline.ts";
import { type ServeFeedWatch, watchServeFeed } from "./serve_feed_client.ts";

const logger = getSwampLogger(["datastore", "v3"]);

export { v3ReplicatesAt };

export type V3DatastoreConfig = V3DatastoreLocation | FilesystemDatastoreConfig;

/** call only for a config the format guard opened as v3 */
export async function v3DatastoreConfigOf(
  repoDir: string,
  config: DatastoreConfig,
): Promise<V3DatastoreConfig> {
  if (!isCustomDatastoreConfig(config)) return config;
  return boundV3BucketLocation(config) ??
    bindV3BucketDatastore(repoDir, config, await resolveCustomProvider(config));
}

export function v3BucketNamespacedStoreAt(
  location: V3DatastoreConfig,
): WritableDatastoreControlPlaneStore | undefined {
  const binding = v3BucketBindingAt(location.path);
  return binding === undefined
    ? undefined
    : v3BucketNamespacedStore(binding, location.namespace);
}

export function v3ServeControlPlaneAt(
  location: V3DatastoreConfig,
): WritableDatastoreControlPlaneStore {
  return v3NamespacedStore(v3ControlPlaneAt(location.path), location.namespace);
}

const opened = new Map<string, V3Datastore>();

/** synced once each at teardown, then released; empty unless replication is on */
const replications = new Map<string, ReplicationHandle[]>();

/**
 * Datastores whose sidecar serve released and could not get back: their
 * commits since then are unconfirmed, so the closing sync must not pass
 * silently.
 */
const owedReplications = new Set<string>();

/**
 * a closing sync that fails after the command's own commits were confirmed
 * covers only later commits (the retention pass's), which never fail the
 * command
 */
let commandConfirmed = false;

/** whether the command committed anything is whether a mark moved */
const commandStartMarks = new Map<
  string,
  { readonly path: string; readonly mark: number }
>();

export type V3CommandCommits =
  | { readonly committed: true }
  | { readonly committed: false; readonly datastorePath: string };

/**
 * a replication error says changes are saved locally, true only if something
 * committed; a process with no replicated writer or open datastore counts as
 * committed. Read before closeV3Datastores
 */
export function v3CommandCommits(): V3CommandCommits {
  if (commandStartMarks.size === 0) return { committed: true };
  const handles = [...opened.values()];
  for (const [datastore, { mark }] of commandStartMarks) {
    const handle = handles.find((h) => resolve(h.datastorePath) === datastore);
    if (handle === undefined) return { committed: true };
    if (handle.commitStore.highWaterMark().cursor > mark) {
      return { committed: true };
    }
  }
  const [{ path }] = commandStartMarks.values();
  return { committed: false, datastorePath: path };
}

/**
 * a replication error says changes are saved locally only for a command that
 * committed something; one that committed nothing changed nothing
 */
export function reportedV3Failure(
  error: unknown,
  commits: V3CommandCommits,
  options: { readonly closing?: boolean } = {},
): unknown {
  if (!(error instanceof V3ReplicationError) || commits.committed) {
    return error;
  }
  const cause = error.cause ?? error;
  if (!isNetworkFailure(error)) {
    return new V3ReplicationUnavailableError(error.detail, { cause });
  }
  return options.closing === true
    ? new V3StorageUnreachableError(
      commits.datastorePath,
      cause,
      "while confirming its replica as the command ended",
    )
    : new V3StorageUnreachableError(commits.datastorePath, cause);
}

let lineageListening = false;

/** while replicating, a handle opens only on one of these */
const currentCopies = new Set<string>();

/** restored copies, so their writers restart a lineage */
const restoredCopies = new Set<string>();

/**
 * kept across teardowns, so a later lease in the process still finds its copy's
 * lineage
 */
const copiesByDatastore = new Map<
  string,
  (V3Copy & { readonly key: string })[]
>();

const caughtUpWriters = new WeakSet<V3Datastore>();
const releases: (() => Promise<void>)[] = [];

/** the first hold's recovery and marker write, which later holds wait for */
const markedCheckouts = new Map<string, Promise<void>>();

/** Teardown keeps the writer markers: work may still be uncommitted. */
let keepMarkers = false;

/**
 * dropped work was not recovered, so the next command recovers it; the close
 * resets this
 */
const keptMarkers = new Set<string>();

/**
 * set once the sidecar is written; a hold at the same fence for the same
 * checkout does not write it again
 */
const recordedCheckouts = new Map<
  string,
  { readonly repoDir: string; readonly fence: number }
>();

let retakeListening = false;

/**
 * a direct writer is refused, datastore claim and release change the claim, and
 * serve writes as the owner only when its address is the owner's
 */
export type V3OwnerCheck =
  | { readonly as: "writer" }
  | { readonly as: "claimer" }
  | { readonly as: "serve"; readonly address: string | undefined };

/**
 * a retake or move of the lease changes the fence and the next commit checks
 * again, so a claim written while serve's lease had lapsed stops serve writing
 */
const serveHolds = new Map<
  string,
  { readonly address: string | undefined; verifiedFence?: number }
>();

/**
 * while serve does not hold the current writer lease it follows, and each
 * commit is refused with the leader this names
 */
const serveTeams = new Map<string, () => ServeLeader | undefined>();

export function enableV3ServeTeamMode(
  datastorePath: string,
  leader: () => ServeLeader | undefined,
): () => void {
  const key = resolve(datastorePath);
  serveTeams.set(key, leader);
  return () => {
    if (serveTeams.get(key) === leader) serveTeams.delete(key);
  };
}

/**
 * backstop for a write no request gate forwarded to the leader; a node whose
 * lease was taken over is refused as fenced by the writer's own check
 */
export function refuseV3FollowerWrite(datastorePath: string): void {
  const leader = serveTeams.get(resolve(datastorePath));
  // a process that held the lease is the writer's check: a lost one is refused
  // as fenced, which says the request may already have done work, never that
  // nothing was changed
  if (leader === undefined || holdsV3WriterLock(datastorePath)) return;
  throw new ServeNotLeaderError(leader());
}

/**
 * restored from the published lineage when behind, then its read model caught
 * up; does nothing while this process leads
 */
export async function refreshV3FollowerCopy(
  repoDir: string,
  config: V3DatastoreConfig,
): Promise<void> {
  if (holdsCurrentV3WriterLease(config.path)) return;
  const key = handleKey(repoDir, config);
  if (v3ReplicatesAt(config.path)) {
    currentCopies.delete(key);
    // A retake by a lost hold's renewal meanwhile makes the copy the
    // writer's: the refresh then leaves it to the retake's own restore.
    await ensureV3CopyCurrent(repoDir, config, "read", {
      stillCurrent: () => !holdsCurrentV3WriterLease(config.path),
    });
  }
  await opened.get(key)?.catchUp();
}

/**
 * serve calls it when its shutdown drain leaves runs that may still be writing,
 * so the next command recovers the checkout
 */
export function keepV3WriterMarkers(): void {
  keepMarkers = true;
}

function handleKey(repoDir: string, config: V3DatastoreConfig): string {
  return [resolve(repoDir), resolve(config.path), config.namespace ?? ""]
    .join("\0");
}

export function v3DatastoreFor(
  repoDir: string,
  config: V3DatastoreConfig,
): V3Datastore {
  if (!lineageListening) {
    // a fence taken outside a writer's hold (read-only recovery, serve's
    // retake) continues the copy's lineage when it may; a writer prepares its
    // own once its copy is current
    lineageListening = true;
    onV3LeaseTaken(async (path, fence) => {
      // Safe before the copy is current: a lineage continues only while
      // no other writer started one since.
      for (const copy of copiesByDatastore.get(resolve(path)) ?? []) {
        await recordV3LeaseFence(copy, fence);
      }
      // serve's retake of a lost hold recovers what a writer between its two
      // holds left; a first hold recovers in recoverAndMark and a read-only
      // hold never recovers
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
        refuseV3FollowerWrite(config.path);
        assertV3WriterCurrent(config.path);
        // while replicating, nothing commits onto a copy that is not current:
        // after serve's retake, until its restore lands
        if (v3ReplicatesAt(config.path) && !currentCopies.has(key)) {
          throw new WriterFencedError(
            v3WriterFence(config.path),
            undefined,
            "copy-restoring",
          );
        }
        assertServeStillOwner(config.path, key);
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
      // nor while another copy may still restore a lineage that names chunks
      // this copy does not, nor before what this copy holds is replicated
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
 * a restore of the replica must never name a chunk the sweep deleted, so sweep
 * only after a sync that resolves after the pass's compaction and while no
 * commit landed since (mark read before and after)
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

function copyOf(repoDir: string, config: { readonly path: string }): V3Copy {
  return {
    datastorePath: config.path,
    repoDir,
    commitsDb: v3CommitsDbPath(config.path, repoDir),
  };
}

/**
 * stillCurrent is asked just before the copy is marked current, since a retake
 * while the restore ran may follow commits the restored lineage lacks; false
 * leaves it not current and the result says stale
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
  // named, since a first clone spends most of its time here
  return await withSpan(
    "swamp.datastore.v3.copy.ensure",
    { "swamp.datastore.v3.mode": mode },
    () => ensureV3CopyCurrentNow(repoDir, config, mode, key, options),
  );
}

async function ensureV3CopyCurrentNow(
  repoDir: string,
  config: V3DatastoreConfig,
  mode: "read" | "write",
  key: string,
  options: { readonly stillCurrent?: () => boolean },
): Promise<V3CopyRefresh & { readonly stale?: true }> {
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
      // rebuild from the restored commits and remove files no commit owns,
      // under the writer lease; a reader that cannot take it replays instead,
      // leaving the dropped commits' files until a rebuild
      const rebuilt = handle ?? v3DatastoreFor(repoDir, config);
      // Before as well as after the replay: this branch does not run again
      // once the copy state names the restore, so a process killed during
      // the replay must already have cleared them.
      await removeStaleOutputSummaries(repoDir);
      try {
        const release = mode === "write"
          ? undefined
          : await tryAcquireV3WriterLock(config.path, { fenceStore: rebuilt });
        if (mode === "write" || release !== undefined) {
          try {
            await rebuilt.recoverInterruptedWriter(0, undefined, {
              entry: "rebuilt",
            });
          } catch (error) {
            if (release !== undefined) {
              await releaseAfterFailure(release, error);
            }
            throw error;
          }
          await release?.();
        } else {
          // files only dropped commits wrote may stay: they go only when the
          // restored store has compacted history, and then possibly by a reader
          // without the writer lease
          await rebuilt.replayEveryCommit();
        }
      } finally {
        // Either way a replay may have put back the records of dropped
        // commits' parents, beneath rows of what they dropped.
        await removeStaleOutputSummaries(repoDir);
      }
    } else if (handle !== undefined) {
      await handle.catchUp();
    }
  }
  return stale ? { ...refresh, stale: true } : refresh;
}

/**
 * a writing command calls it before taking any other lock, so it never holds
 * the global or a model lock while waiting for another writer
 */
export async function holdV3Writer(
  config: V3DatastoreConfig,
  repoDir: string,
  options: {
    readonly retakeLost?: boolean;
    readonly ownerCheck?: V3OwnerCheck;
    /**
     * follow instead of waiting: the lease is tried once; a busy one leaves
     * this process reading its own current copy and holding nothing
     */
    readonly follow?: boolean;
    /**
     * the command's lock catches the copy up, or catchUpDeferredAt does; only
     * for a copy that has read serve's feed, so it can go offline at the lock
     */
    readonly catchUpAtLock?: boolean;
  } = {},
): Promise<"writer" | "follower"> {
  let role: "writer" | "follower";
  try {
    role = await takeV3WriterHold(config, repoDir, options);
  } catch (error) {
    if (!(error instanceof UserError) && isNetworkFailure(error)) {
      throw new V3StorageUnreachableError(config.path, error);
    }
    throw error;
  }
  // a serve-upstream checkout holds only a local lease, ordering this machine's
  // processes; serve orders the writers. Its copy is brought up to serve's log
  // before it writes, or goes offline if serve is unreachable
  if (role === "writer" && serveUpstreamAt(config.path) !== undefined) {
    const handle = v3DatastoreFor(repoDir, config);
    if (
      options.catchUpAtLock === true && handle.serveHasReadFeed?.() === true
    ) {
      deferTo(handle);
    } else {
      await handle.catchUpForWrite?.(undefined, { mayGoOffline: true });
    }
    caughtUpFromServe.add(handle);
  }
  return role;
}

/**
 * handles whose writer hold left serve's catch-up to the command's lock; their
 * feed watch waits for it, so it neither adds requests nor applies commits
 * alongside the lock's page
 */
const deferredCatchUps = new Map<V3Datastore, PromiseWithResolvers<void>>();

function deferTo(handle: V3Datastore): void {
  if (!deferredCatchUps.has(handle)) {
    deferredCatchUps.set(handle, Promise.withResolvers<void>());
  }
}

function endDeferral(handle: V3Datastore): void {
  deferredCatchUps.get(handle)?.resolve();
  deferredCatchUps.delete(handle);
}

/** whether a writer hold at `datastorePath` left its catch-up to a lock */
export function catchUpDeferredTo(datastorePath: string): boolean {
  const path = resolve(datastorePath);
  return [...deferredCatchUps.keys()].some((handle) =>
    resolve(handle.datastorePath) === path
  );
}

/**
 * the catch-up a deferred writer hold left undone, for a command that takes no
 * lock after all; it may go offline as the hold's would have
 */
export async function catchUpDeferredAt(datastorePath: string): Promise<void> {
  const path = resolve(datastorePath);
  for (const [handle] of [...deferredCatchUps]) {
    if (resolve(handle.datastorePath) !== path) continue;
    try {
      await handle.catchUpForWrite?.(undefined, { mayGoOffline: true });
      await handle.catchUpReadModel?.();
    } finally {
      endDeferral(handle);
    }
  }
}

/**
 * a lock at serve found it unreachable before a deferred catch-up made any
 * contact: the hold's offline rule applies; true when the checkout went offline
 */
export function goServeOfflineAt(
  datastorePath: string,
  error: unknown,
): boolean {
  const path = resolve(datastorePath);
  let offline = false;
  for (const [handle] of [...deferredCatchUps]) {
    if (resolve(handle.datastorePath) !== path) continue;
    if (handle.goOfflineOnUnreachable?.(error) === true) {
      offline = true;
      endDeferral(handle);
    }
  }
  return offline;
}

/**
 * handles holdV3Writer just caught up from serve: the repository open that
 * follows it brings only the read model up, not serve's feed again
 */
const caughtUpFromServe = new WeakSet<V3Datastore>();

/**
 * does nothing for a datastore not read through serve, so serve itself never
 * watches; the watches stop when the datastores close, before anything else
 * closes
 */
export function watchV3ServeFeeds(): void {
  for (const handle of [...opened.values()]) {
    const binding = serveUpstreamAt(handle.datastorePath);
    if (binding === undefined) continue;
    feedWatches.push(watchServeFeed({
      target: binding.target,
      catchUp: (signal) => handle.catchUp(signal),
      // a writer hold that left its catch-up to the lock holds the feed's
      // until the lock's has applied
      ready: async (signal) => {
        const deferred = deferredCatchUps.get(handle);
        if (deferred === undefined) return;
        signal.throwIfAborted();
        await Promise.race([
          deferred.promise,
          new Promise<void>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        ]);
      },
      ...(handle.serveFeedCursor !== undefined
        ? { appliedCursor: () => handle.serveFeedCursor!() }
        : {}),
      ...(handle.sentToServe !== undefined
        ? { sentHere: (txnId: string) => handle.sentToServe!(txnId) }
        : {}),
      ...(handle.catchUpReadModel !== undefined
        ? { catchUpLocally: (signal) => handle.catchUpReadModel!(signal) }
        : {}),
    }));
  }
}

const feedWatches: ServeFeedWatch[] = [];

/**
 * where the one copy read through serve at `datastorePath` stands, which a
 * lock asks serve to answer with what the copy lacks
 */
export function serveCatchUpRequestAt(
  datastorePath: string,
): CatchUpRequest | undefined {
  const path = resolve(datastorePath);
  const handles = [...opened.values()].filter((handle) =>
    resolve(handle.datastorePath) === path
  );
  return handles.length === 1 ? handles[0].serveCatchUpRequest?.() : undefined;
}

/**
 * a serve-mode checkout calls it once it holds a lock at serve, so the work
 * under the lock reads every version another machine wrote; holdV3Writer's
 * catch-up ran before the lock was taken
 */
export async function catchUpV3HandlesAt(
  datastorePath: string,
  options?: CatchUpOptions,
  delivered?: DeliveredCatchUp,
): Promise<void> {
  const path = resolve(datastorePath);
  const handles = [...opened.values()].filter((handle) =>
    resolve(handle.datastorePath) === path
  );
  for (const handle of handles) {
    if (handle.catchUpForWrite !== undefined) {
      // a page asked for one copy is that copy's alone
      try {
        await handle.catchUpForWrite(
          undefined,
          delivered !== undefined && handles.length === 1
            ? { delivered }
            : undefined,
        );
      } finally {
        endDeferral(handle);
      }
      await (handle.catchUpReadModel?.(undefined, options) ??
        handle.catchUp(undefined, options));
    } else {
      await handle.catchUp(undefined, options);
    }
  }
}

async function takeV3WriterHold(
  config: V3DatastoreConfig,
  repoDir: string,
  options: {
    readonly retakeLost?: boolean;
    readonly ownerCheck?: V3OwnerCheck;
    readonly follow?: boolean;
  },
): Promise<"writer" | "follower"> {
  // before the lease and the recovery of an interrupted writer, which would
  // meet the same checkout
  await refuseUnsafeV3Checkout(repoDir, config);
  // a checkout that holds records never joins: refused before the lease, which
  // records this checkout in the datastore
  await assertV3CheckoutJoinable(repoDir, config.namespace);
  // Before the handle opens: opening migrates commits.db, which a swamp from
  // before the lease, still writing, could not open again.
  await refuseLiveV3LegacyWriter(config.path);
  const key = handleKey(repoDir, config);
  // a claim this writer may not write under, as the file showed before the
  // lease, so it need not wait on a lease serve holds; only the check under the
  // lease decides
  const claimHint = serveUpstreamAt(config.path) === undefined
    ? claimRefusal(
      peekDatastoreOwner(v3CommitsDbPath(config.path, repoDir)),
      ownerCheckOf(config, options.ownerCheck),
    )
    : undefined;
  // a claim this serve may not write under is refused as before: it never
  // follows
  const follows = options.follow === true && claimHint === undefined &&
    serveUpstreamAt(config.path) === undefined;
  let release: () => Promise<void>;
  try {
    release = await acquireV3WriterLock(config.path, {
      maxWaitMs: claimHint === undefined && !follows
        ? resolveLockTimeoutMs()
        : 0,
      // records the lease's fence in commits.db, so a writer that loses the
      // lease can commit nothing; while replicating the copy opens only once
      // current and the first fence is raised then; a retake raises it here
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
  } catch (error) {
    if (follows && error instanceof V3WriterBusyError) {
      await followV3Datastore(config, repoDir, options.ownerCheck);
      return "follower";
    }
    if (claimHint !== undefined && error instanceof V3WriterBusyError) {
      // A replicated checkout read its last copy, which can predate a
      // release: say so, so a stale claim is not taken for a live one.
      if (!v3ReplicatesAt(config.path)) throw claimHint;
      throw withStrandedOutbox(
        new DatastoreClaimedError(
          claimHint.owner,
          [
            "This checkout's last copy of the datastore shows the claim, and " +
            "another process holds the writer lease, so the write was not " +
            "tried. If the claim was released since, run the command again " +
            "once that process is done.",
            claimHint.detail,
          ].filter((part) => part !== undefined).join(" "),
          claimHint.wayOut,
        ),
        config,
        repoDir,
      );
    }
    throw error;
  }
  if (v3ReplicatesAt(config.path)) {
    try {
      // the lease first, then the restore: every commit the previous writer
      // acknowledged is in what this one restores
      await ensureV3CopyCurrent(repoDir, config, "write");
      const handle = v3DatastoreFor(repoDir, config);
      const fence = v3WriterFence(config.path);
      if (fence !== undefined) await handle.raiseWriterFence(fence);
      // before the recovery, lineage and sidecar this hold starts, which can
      // fail before the command commits anything
      // only a CLI command's teardown reads the marks; serve's would go stale
      const datastore = resolve(config.path);
      if (
        ownerCheckOf(config, options.ownerCheck).as !== "serve" &&
        !commandStartMarks.has(datastore)
      ) {
        commandStartMarks.set(datastore, {
          path: config.path,
          mark: handle.commitStore.highWaterMark().cursor,
        });
      }
    } catch (error) {
      await releaseAfterFailure(release, error);
      throw error;
    }
  }
  // checked once the lease is held and the copy current, before recovery lands
  // any commit, so a claim written while this writer waited is seen. A
  // serve-mode checkout writes through serve, the owner
  if (serveUpstreamAt(config.path) === undefined) {
    try {
      refuseUnlessOwner(config, repoDir, options.ownerCheck);
    } catch (error) {
      await releaseAfterFailure(release, error);
      throw error;
    }
  }
  const checkout = handleKey(repoDir, config);
  let marking = markedCheckouts.get(checkout);
  const marks = marking === undefined;
  if (marking === undefined) {
    // a writer that ended without tearing down left files no commit names:
    // recover them before this process writes; later holds in this process wait
    // for the same recovery
    marking = recoverAndMark(config, repoDir);
    // Handled here, awaited below: a recovery that fails while the sidecar
    // write is still pending must not reject unhandled.
    marking.catch(() => {});
    markedCheckouts.set(checkout, marking);
  }
  try {
    await recordWriterCheckout(config.path, repoDir);
    await marking;
    // a sidecar for this hold's fence once the checkout is recovered and
    // marked, when replication is on
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
  return "writer";
}

/**
 * nothing is marked or replicated: the writer does that; the claim is checked
 * as the lease's hold would, so a serve with another --address is refused here
 * too; its own gone predecessor is recovered now, off the takeover's path
 */
async function followV3Datastore(
  config: V3DatastoreConfig,
  repoDir: string,
  ownerCheck: V3OwnerCheck | undefined,
): Promise<void> {
  await ensureV3CopyCurrent(repoDir, config, "read");
  const handle = v3DatastoreFor(repoDir, config);
  const refusal = claimRefusal(
    handle.commitStore.owner(),
    ownerCheckOf(config, ownerCheck),
  );
  if (refusal !== undefined) throw refusal;
  await recoverOwnPredecessor(handle, repoDir);
  // Holding no lease, this process must commit nothing from here on, before
  // serve's leadership names the leader: a partition that never saw a fence
  // would take an unfenced commit.
  const key = resolve(config.path);
  if (!serveTeams.has(key)) serveTeams.set(key, () => undefined);
}

/**
 * serve's hold is remembered, so a later hold in the same process is serve's
 * too and its commits check the claim again whenever the fence moves
 */
function refuseUnlessOwner(
  config: V3DatastoreConfig,
  repoDir: string,
  ownerCheck: V3OwnerCheck | undefined,
): void {
  const datastore = resolve(config.path);
  const check = ownerCheckOf(config, ownerCheck);
  // A claimer changes the claim whatever it says, so it never reads it: a
  // row that cannot be read still lets `datastore release` remove it.
  const refusal = check.as === "claimer" ? undefined : claimRefusal(
    v3DatastoreFor(repoDir, config).commitStore.owner(),
    check,
  );
  if (refusal !== undefined) throw withStrandedOutbox(refusal, config, repoDir);
  if (check.as === "serve") {
    serveHolds.set(datastore, {
      address: check.address,
      verifiedFence: v3WriterFence(config.path),
    });
  }
}

function ownerCheckOf(
  config: V3DatastoreConfig,
  ownerCheck: V3OwnerCheck | undefined,
): V3OwnerCheck {
  const serve = serveHolds.get(resolve(config.path));
  return ownerCheck ??
    (serve !== undefined
      ? { as: "serve", address: serve.address }
      : { as: "writer" });
}

/**
 * a retake or a move of the lease is the only way a claim can change under
 * serve's hold, so check again only when the fence moved since it last named
 * serve
 */
function assertServeStillOwner(datastorePath: string, key: string): void {
  const serve = serveHolds.get(resolve(datastorePath));
  if (serve === undefined) return;
  const fence = v3WriterFence(datastorePath);
  if (fence === undefined || fence === serve.verifiedFence) return;
  const handle = opened.get(key);
  if (handle === undefined) return;
  const refusal = claimRefusal(handle.commitStore.owner(), {
    as: "serve",
    address: serve.address,
  });
  if (refusal !== undefined) {
    logger
      .error`The v3 datastore at ${datastorePath} is now claimed by ${refusal.owner.address}: this serve writes nothing to it until it is restarted with that --address, or the claim is released`;
    throw refusal;
  }
  serve.verifiedFence = fence;
}

/**
 * only a replicated checkout has an outbox of its own: on a shared filesystem
 * datastore the claim's own hold lands them before the claim. The command
 * itself still changed nothing
 */
function withStrandedOutbox(
  refusal: DatastoreClaimedError,
  config: V3DatastoreConfig,
  repoDir: string,
): DatastoreClaimedError {
  if (!v3ReplicatesAt(config.path)) return refusal;
  const outbox = v3OutboxPath(v3CommitsDbPath(config.path, repoDir));
  const pending = countPendingOutboxEntries(outbox);
  if (pending === 0) return refusal;
  const commits = pending === 1 ? "1 commit" : `${pending} commits`;
  const stranded = `This checkout also holds ${commits} an earlier ` +
    "command on it made that never reached the datastore. They stay in " +
    `${outbox}: they land if the claim is released and a command runs in ` +
    "this checkout directly, and they are not sent through serve. To keep " +
    "them, release the claim with 'swamp datastore release', run a command " +
    "in this checkout, then claim again; or redo the work through serve.";
  return markErrorPaths(
    new DatastoreClaimedError(
      refusal.owner,
      [refusal.detail, stranded].filter((part) => part !== undefined)
        .join(" "),
      refusal.wayOut,
    ),
    [outbox],
  );
}

function claimRefusal(
  owner: DatastoreOwner | undefined,
  check: V3OwnerCheck,
): DatastoreClaimedError | undefined {
  if (owner === undefined) return undefined;
  switch (check.as) {
    case "claimer":
      return undefined;
    case "writer":
      return new DatastoreClaimedError(owner);
    case "serve":
      if (check.address !== undefined && owner.isAddress(check.address)) {
        return undefined;
      }
      return new DatastoreClaimedError(
        owner,
        check.address === undefined
          ? "This serve was started without --address, so it cannot write as the owner."
          : `This serve's --address is ${
            normalizeOwnerAddress(check.address)
          }, not the owner's.`,
        `Start the owner serve with --address ${owner.address}, or ` +
          "release the claim with 'swamp datastore release'.",
      );
  }
}

/** a hold that was lost records nothing: its sidecar is the new writer's now */
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
  // a bucket datastore's local root has no _control/ of its own until this
  // first write
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
    // serve's retake writes the checkout under its new fence, so readers there
    // stay out
    onV3HoldRetaken(async (path, retaken) => {
      const previous = recordedCheckouts.get(resolve(path));
      if (previous === undefined || previous.fence === retaken) return;
      await recordWriterCheckout(path, previous.repoDir);
    });
  }
}

/**
 * a recovery that fails names the marker, so a user can clear it when the
 * failure persists
 */
async function recoverAndMark(
  config: V3DatastoreConfig,
  repoDir: string,
): Promise<void> {
  // what a writer that died left in the outbox lands first, so the
  // interrupted-writer recovery keeps the files its commits own; failures name
  // the outbox, not the marker
  const handle = v3DatastoreFor(repoDir, config);
  const fence = v3WriterFence(config.path);
  if (fence !== undefined) await recoverV3Outbox(handle, fence);
  try {
    await recoverInterruptedWriter(handle, repoDir, {
      holdsWriterLock: true,
    });
  } catch (error) {
    // cut off from the storage, the recovery is retried by the next command;
    // the hold gives the failure its code
    if (!(error instanceof UserError) && isNetworkFailure(error)) throw error;
    // a stopped command: the marker stays, so the next command resumes
    if (commandStopSignal().aborted) throw error;
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
  // a marker left stays: another host's or live process's, whose writer may yet
  // leave uncommitted files, or this process's own from before a kept close. An
  // unreadable one was recovered above
  if ((await readWriterMarkerFile(repoDir)).kind === "absent") {
    await writeWriterMarker(repoDir);
  }
}

/** a writer recovers once per fence it takes */
const outboxRecoveredAt = new Map<string, number>();

/**
 * checkouts sharing the datastore's commits.db share its outbox, so recover
 * once per fence per store
 */
async function recoverV3Outbox(
  handle: V3Datastore,
  fence: number,
): Promise<void> {
  const store = resolve(handle.commitsDbPath);
  if (outboxRecoveredAt.get(store) === fence) return;
  // a serve-mode checkout lands its entries through serve, never only in its
  // copy of serve's log
  const upstream = handle.serveUpstreamStore;
  try {
    await recoverCommitOutbox(
      upstream === undefined ? handle : {
        ...handle,
        commitStore: upstream,
        // what the checkout queued offline is flushed here, under the writer
        // hold: read-only commands never flush
        ...(handle.offlineFlushPort !== undefined
          ? { offline: handle.offlineFlushPort }
          : {}),
      },
      {
        fence,
        writer: handle.writer,
        ...(upstream !== undefined ? { forwarded: true } : {}),
      },
    );
  } catch (error) {
    // serve unreachable: what the outbox holds waits for the next command that
    // reaches it; the writer hold's catch-up decides whether this one works
    // offline or is refused
    if (upstream !== undefined && error instanceof ServeUnreachableError) {
      logger
        .debug`Could not reach serve to land this checkout's outbox; a later command lands it: ${error}`;
      return;
    }
    throw error;
  }
  outboxRecoveredAt.set(store, fence);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * a reader in that same checkout must not catch up while the writer runs: its
 * files are newer than its last commit, and replaying older commits over them
 * would undo its work
 */
function writerCheckoutPath(datastorePath: string): string {
  return join(datastorePath, "_control", "writer.checkout.json");
}

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
 * removes the sidecar only when it is still this process's record at the fence
 * it wrote it with; a writer that took over wrote its own
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

async function canonicalPath(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * protects the writer while it runs, whatever its TTL, and until a higher fence
 * fences it when this process cannot judge it; a released fence keeps the
 * protection until a new writer raises its fence
 */
async function anotherProcessWritesCheckout(
  repoDir: string,
  datastorePath: string,
): Promise<WriterCheckoutRecord | undefined> {
  const recorded = await readWriterCheckout(datastorePath);
  if (
    recorded === undefined || recorded.repoDir !== await canonicalPath(repoDir)
  ) {
    return undefined;
  }
  const local = await localProcess();
  // This process's own sidecar, known by the fence it wrote it with: never
  // judged by liveness, which may not place this process when its boot id
  // cannot be read.
  if (isOwnWriterCheckout(datastorePath, recorded, local)) return undefined;
  // Judged before the lease is read: a gone writer's sidecar costs no read
  // of the lease's records.
  if (!mayBeAnotherWriter(recorded, local)) return undefined;
  const holder = await v3WriterLeaseHolder(datastorePath);
  if (holder === null) return undefined;
  const writes = recorded.fence === undefined
    ? legacyWriterWritesCheckout(recorded, holder)
    : holder.fence === recorded.fence;
  return writes ? recorded : undefined;
}

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
 * by pid and identity, whatever the hostname is now; a record without an
 * identity, or one this kernel cannot place, by pid and hostname
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
 * a sidecar from before identities, judged by the lease record of the same
 * process: on this host by its pid, else within its TTL
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
 * catches the read model up first, so the context reads every commit made
 * before it opened; fetchForeignContent replaces the v2 sync service's fetcher
 * since builders spread this config after it
 */
export async function v3RepositoryFactoryConfig(
  repoDir: string,
  config: V3DatastoreConfig,
  options: {
    readonly managedConfig?: boolean;
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
  // a checkout that holds records never joins: refused before its copy is
  // restored or its read model opens
  await assertV3CheckoutJoinable(repoDir, config.namespace);
  const writer = holdsV3WriterLock(config.path);
  // a reader's copy is made current first, unless another process writes this
  // checkout: that writer keeps it current
  if (
    !writer && v3ReplicatesAt(config.path) &&
    await anotherProcessWritesCheckout(repoDir, config.path) !== undefined
  ) {
    currentCopies.add(handleKey(repoDir, config));
  } else if (!writer) {
    try {
      await ensureV3CopyCurrent(repoDir, config, "read");
    } catch (error) {
      // cut off from the replica's storage, the reader changed nothing, and the
      // next command makes its copy current
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
  // before the recovery and catch-up: a projection another view built (a serve
  // copy of another token, address or namespace, or the solo log) is rebuilt
  // from this one first
  await alignCheckoutView(
    repoDir,
    handle,
    checkoutViewOf(
      config.path,
      config.namespace ?? "",
      handle.serveCopyId,
      handle.servePrincipal,
    ),
    { holdsWriterLock: writer },
  );
  // in a checkout another process writes its files are already newest, so
  // catching up would replay older commits over them; a writer catches up once,
  // so a context opened mid-command cannot replay over its rewrites
  if (!writer) {
    // a read-only command recovers a checkout whose writer ended without
    // tearing down, when it can take the writer lock; a failed recovery leaves
    // the marker for the next command and the read goes on
    try {
      await recoverInterruptedWriter(handle, repoDir, {
        holdsWriterLock: false,
      });
    } catch (error) {
      logger
        .warn`Recovering ${repoDir} after an interrupted v3 writer failed; the next command retries: ${error}`;
    }
  }
  const otherWriter = writer && caughtUpWriters.has(handle)
    ? undefined
    : await anotherProcessWritesCheckout(repoDir, config.path);
  if (writer && caughtUpWriters.has(handle)) {
    // Caught up when this process's first context opened.
  } else if (otherWriter === undefined) {
    if (
      writer && caughtUpFromServe.has(handle) &&
      handle.catchUpReadModel !== undefined
    ) {
      caughtUpFromServe.delete(handle);
      await handle.catchUpReadModel();
    } else {
      await handle.catchUp();
    }
    if (writer) caughtUpWriters.add(handle);
  } else {
    // the writer's files are newest only once the read model is complete; until
    // then a catch-up is in progress or cut short, so wait for it, bounded by
    // the lock timeout, and finish it if cut short
    await handle.catchUpUnlessComplete(
      resolveLockTimeoutMs(),
      otherWriter.pid,
    );
  }
  const unreadableContent = unreadableContentLookup(repoDir, handle.readModel);
  return {
    commitLog: (markDirty, runRepo) =>
      handle.engineFor(markDirty, runRepo, {
        readOnly: options.readOnly === true,
      }),
    catalogStore: handle.catalogStore,
    // a read of a record the read model could not materialise fails loudly
    unreadableContent,
    // another namespace's row is read from its own cache root in this checkout,
    // never from this namespace's
    fetchForeignContent: v3ForeignContentFetcher(
      repoDir,
      config,
      unreadableContent,
    ),
  };
}

export const V3_RESERVED_NAMESPACE_CODE = "datastore_v3_reserved_namespace";

/**
 * a reserved namespace's cache root is a directory swamp keeps its own files
 * in, and subdirectories linking out of their cache root would fail every
 * catch-up
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

function keepsMarker(repoDir: string): boolean {
  return keepMarkers || keptMarkers.has(resolve(repoDir));
}

/**
 * it holds a current writer lease, and while replicating its copy is current;
 * only then may it rebuild the checkout
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
 * what it would confirm replicates with the next write in this checkout, so the
 * command does not wait for it
 */
export const UNREACHABLE_SYNC_DEADLINE_MS = 1_000;

/** a sync that answers sooner, as a healthy one does, is never probed */
export const STORAGE_PROBE_GRACE_MS = 2_000;

/**
 * one that cannot finish leaves the lease to expire by its TTL, as a release
 * that fails does
 */
export const UNREACHABLE_RELEASE_BOUND_MS = 1_000;

/**
 * within what the shutdown deadline has left: a slow bucket otherwise holds it
 * behind a renewal in flight and then its own write; one that misses leaves the
 * lease to expire by its TTL
 */
export const SHUTDOWN_RELEASE_BOUND_MS = 5_000;

let teardownTiming = {
  probeGraceMs: STORAGE_PROBE_GRACE_MS,
  releaseBoundMs: UNREACHABLE_RELEASE_BOUND_MS,
};

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
 * aborts signal when the storage cannot be reached, so the sync is given up as
 * a definite failure instead of waiting out its deadline; nothing is watched
 * when storage is already known unreachable
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
 * with the storage unreachable a release can only fail, and at serve's shutdown
 * a slow bucket must not hold the process past its deadline; one that misses
 * leaves the lease to expire by its TTL
 */
async function boundedRelease(
  release: () => Promise<void>,
  boundMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = release().catch((error) => {
    logger
      .debug`A bounded v3 writer lease release failed; the lease expires on its own: ${error}`;
  });
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger
        .debug`Not waiting longer for a v3 writer lease release; the lease expires on its own`;
      resolve();
    }, boundMs);
  });
  try {
    await Promise.race([running, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * the original failure stays the error reported; a release that fails too, as
 * one cut off from the storage does, is logged and the lease expires by its TTL
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
 * a process that lost its lease, a checkout with a unit still open, or a
 * recovery that fails keeps the writer marker instead, so the next command
 * recovers. Never fails the teardown
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
    // its replay would wait on the storage too
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
        await removeStaleOutputSummaries(checkout);
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
 * with the storage known unreachable nothing waits on retries that cannot
 * succeed: compaction and dropped-work recovery are left to the next command,
 * and the sync and lease releases are bounded
 */
export async function closeV3Datastores(
  options: { readonly storageUnreachable?: boolean } = {},
): Promise<void> {
  await Promise.all(feedWatches.splice(0).map((watch) => watch.stop()));
  closeServeLockClients();
  let unreachable = options.storageUnreachable === true;
  // Serve's shutdown deadline, kept for the release once the sync's turn
  // has cleared it.
  const shutdownDeadline = v3ClosingDeadline();
  const pending = releases.splice(0);
  markedCheckouts.clear();
  commandStartMarks.clear();
  serveHolds.clear();
  serveTeams.clear();
  // offline mode lasts the command; json mode says what it queued now, after
  // its result
  reportQueuedOffline();
  resetServeOffline();
  const entries = [...opened.entries()];
  const handles = entries.map(([, handle]) => handle);
  opened.clear();
  // whether each checkout that dropped work may recover it now, judged while
  // the lease and copy state are here
  const dropped = entries.flatMap(([key, handle]) =>
    handle.droppedWork() === undefined
      ? []
      : [{ key, handle, current: writesCurrentCopy(key, handle) }]
  );
  // a writer folds history the policy does not retain before it lets go of the
  // lock: compaction is the single writer's
  for (const handle of unreachable ? [] : handles) {
    if (!holdsV3WriterLock(handle.datastorePath)) continue;
    // a sidecar already gone (signalled with this process) replicates nothing
    // more, so no commit is made that no replica could hold
    const use = replications.get(resolve(handle.datastorePath))?.[0];
    if (use !== undefined && !await use.probe()) {
      logger
        .debug`Not compacting the v3 datastore at ${handle.datastorePath} at close: its Litestream sidecar is gone`;
      continue;
    }
    await compactQuietly(handle, CLOSING_COMPACTION_BUDGET_MS);
  }
  // one sync per datastore confirms every commit this process made,
  // compaction's included; before the stores close, since it makes Litestream
  // open commits.db and the WAL must survive for the next sidecar start
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
      const startedAt = Date.now();
      try {
        return await syncAndPublish(
          datastore,
          uses[0],
          handles,
          deadlineMs,
          watch.signal,
          // serve's shutdown deadline covers the wait for a probe's sync too
          { queueWaitCounts: shutdownDeadline !== undefined },
        );
      } catch (error) {
        const left = deadlineMs - (Date.now() - startedAt);
        if (
          !(error instanceof V3ReplicationError) ||
          watch.signal?.aborted === true ||
          left < MIN_QUEUED_SYNC_MS || await uses[0].probe()
        ) {
          throw error;
        }
        return await confirmClosedFromReplica(
          datastore,
          uses[0],
          handles,
          left,
          watch.signal,
          error,
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
  setV3ClosingDeadline(undefined);
  // After the closing sync, which serve's drain deadline is for, and before
  // the stores close.
  for (const { key, handle, current } of dropped) {
    await recoverDroppedWork(key, handle, current, unreachable);
  }
  // once the command's own commits were confirmed, a closing sync that fails
  // covers only what was committed since: kept in commits.db, it replicates
  // with the next write and does not fail the command
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
    pending.map((release) =>
      unreachable
        ? boundedRelease(release, teardownTiming.releaseBoundMs)
        : shutdownDeadline !== undefined
        ? boundedRelease(
          release,
          shutdownDeadline.remaining(SHUTDOWN_RELEASE_BOUND_MS),
        )
        : release()
    ),
  );
  keepMarkers = false;
  keptMarkers.clear();
  clearServeUnreachableLatches();
  // A replication failure comes first: it is what the command reports.
  const failed = [...closing, ...closed, ...unheld, ...released].find((
    result,
  ) => result.status === "rejected");
  if (failed !== undefined && failed.status === "rejected") {
    throw failed.reason;
  }
}

/**
 * publishes between the sync and the lease check the head it confirmed (the
 * last commit before the sync is the mark); with queueWaitCounts the wait for a
 * running sync counts against deadlineMs
 */
async function syncAndPublish(
  datastore: string,
  use: ReplicationHandle,
  handles: readonly V3Datastore[],
  deadlineMs: number,
  signal?: AbortSignal,
  options: { readonly queueWaitCounts?: boolean } = {},
): Promise<number | undefined> {
  // One at a time per datastore: serve's probe and a drain can both sync,
  // and a head taken earlier must never be published over a later one.
  const ahead = publishing.get(datastore);
  const previous = ahead ?? Promise.resolve();
  const startedAt = Date.now();
  const run = (async () => {
    if (options.queueWaitCounts !== true) {
      await previous.catch(() => {});
      return await syncAndPublishNow(
        datastore,
        use,
        handles,
        deadlineMs,
        signal,
      );
    }
    const left = () => deadlineMs - (Date.now() - startedAt);
    // Serve's closing sync otherwise waited out a probe's sync on a slow
    // bucket before its own deadline started. Too little left once the one
    // ahead settles is given up as a wait that never ended.
    if (
      !await settlesWithin(previous, deadlineMs) ||
      (ahead !== undefined && left() < MIN_QUEUED_SYNC_MS)
    ) {
      throw new V3ReplicationError(
        `the sync did not finish within ${
          Math.round(deadlineMs / 1000)
        }s: an earlier sync of this datastore was still running`,
      );
    }
    return await syncAndPublishNow(datastore, use, handles, left(), signal);
  })();
  // The next sync waits for this one and for the one it gave up on.
  const turn = Promise.allSettled([previous, run]);
  publishing.set(datastore, turn);
  try {
    return await run;
  } finally {
    if (publishing.get(datastore) === turn) publishing.delete(datastore);
  }
}

async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = promise.then(() => true, () => true);
  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([settled, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * with less left than this, a closing sync that waited for an earlier one gives
 * up instead of starting
 */
const MIN_QUEUED_SYNC_MS = 500;

const publishing = new Map<string, Promise<unknown>>();

// a lineage head is one bucket object per lineage and writer fence
const headPacers = new Map<
  string,
  { readonly head: string; readonly pacer: HeadPublishPacer }
>();

const HEAD_OBJECT = /\/head-\d+\.json$/;

function headPacerFor(
  datastore: string,
  lineageFence: number,
  writerFence: number,
): HeadPublishPacer | undefined {
  if (v3BucketBindingAt(datastore) === undefined) return undefined;
  const head = `${lineageFence}/${writerFence}`;
  const known = headPacers.get(datastore);
  if (known?.head === head) return known.pacer;
  const pacer = new HeadPublishPacer();
  headPacers.set(datastore, { head, pacer });
  return pacer;
}

async function waitForHeadPacer(
  pacer: HeadPublishPacer | undefined,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  const wait = pacer?.waitWithin(Date.now(), deadlineMs, MIN_QUEUED_SYNC_MS) ??
    0;
  if (wait <= 0) return 0;
  try {
    await abortableSleep(wait, signal);
  } catch (error) {
    throw new V3ReplicationError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return wait;
}

/**
 * a sidecar signalled with this process (a unit's whole cgroup) did its own
 * final sync but can no longer say so: the replica is read instead, never a
 * new sidecar, so this process keeps its hold and lease throughout
 */
async function confirmClosedFromReplica(
  datastore: string,
  use: ReplicationHandle,
  handles: readonly V3Datastore[],
  deadlineMs: number,
  signal: AbortSignal | undefined,
  syncError: V3ReplicationError,
): Promise<number | undefined> {
  const handle = handles.find((h) => resolve(h.datastorePath) === datastore);
  if (
    handle !== undefined &&
    handle.commitStore.highWaterMark().cursor <=
      (publishedMarks.get(datastore) ?? -1)
  ) {
    return publishedMarks.get(datastore);
  }
  try {
    return await syncAndPublishNow(
      datastore,
      use,
      handles,
      deadlineMs,
      signal,
      "replica",
    );
  } catch (error) {
    if (error instanceof WriterFencedError) throw error;
    logger
      .warn`The closing sync of the v3 datastore at ${datastore} found its Litestream sidecar gone, and reading the replica did not confirm this copy's commits: ${error}`;
    throw syncError;
  }
}

async function syncAndPublishNow(
  datastore: string,
  use: ReplicationHandle,
  handles: readonly V3Datastore[],
  deadlineMs: number,
  signal?: AbortSignal,
  via: "sync" | "replica" = "sync",
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
    if (via === "replica") throw new V3ReplicationError("no copy to check");
    await use.sync(deadlineMs, signal === undefined ? {} : { signal });
    return undefined;
  }
  const pacer = headPacerFor(datastore, use.lineageFence, writerFence);
  const left = deadlineMs -
    await waitForHeadPacer(pacer, deadlineMs, signal);
  // taken before the sync: what the sync covers. A serve that lost its lease
  // meanwhile still publishes this head before its lease check fails; it covers
  // only commits nobody acknowledged
  const mark = handle.commitStore.highWaterMark();
  let first = false;
  const confirmOptions = {
    ...(signal === undefined ? {} : { signal }),
    beforeLeaseCheck: async (txid: string) => {
      pacer?.attempted(Date.now());
      try {
        first = await publishV3Head(copy, {
          lineageFence: use.lineageFence,
          writerFence,
          txid,
          mark,
        });
      } finally {
        // its retries wrote the head too
        pacer?.attempted(Date.now());
      }
    },
  };
  const scope = {
    deadlineAt: Date.now() + left,
    onRefused: (refusal: BucketWriteRefusal, object: string) => {
      if (refusal === "rate_limited" && HEAD_OBJECT.test(object)) {
        pacer?.rateLimited(Date.now());
      }
    },
  };
  await withBucketWriteScope(scope, async () => {
    if (via === "replica") {
      await use.confirmFromReplica(
        peekHighWaterCursor,
        mark.cursor,
        left,
        confirmOptions,
      );
    } else {
      await use.sync(left, confirmOptions);
    }
  });
  publishedMarks.set(
    datastore,
    Math.max(publishedMarks.get(datastore) ?? 0, mark.cursor),
  );
  for (const listener of [...(publishListeners.get(datastore) ?? [])]) {
    try {
      listener();
    } catch {
      // A listener's failure is its own.
    }
  }
  // the lease check passed: the heads below this writer's are never read again
  await pruneV3Heads(copy, use.lineageFence, writerFence);
  if (first) {
    // a bucket datastore's old lineage paths go through its provider's replica
    // paths
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
 * called once the action has returned, so a later closing-sync failure covers
 * only the retention pass's own commits, which never fail the command; a head
 * already covering the commits is not synced again
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

const groupCommits = new Map<string, ReplicationGroupCommit>();

/**
 * concurrent requests share syncs; one whose commits a published head already
 * covers does not sync; unconfirmed commits stay in commits.db and ship with
 * the next sync
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
    group = new ReplicationGroupCommit((covering) =>
      syncForRequests(datastore, covering)
    );
    groupCommits.set(datastore, group);
  }
  await group.confirm(mark);
}

/**
 * -1 when not open; serve reads it when a write request starts, so a request
 * that committed nothing confirms nothing
 */
export function v3CommitMark(datastorePath: string): number {
  const datastore = resolve(datastorePath);
  const handle = [...opened.values()].find((h) =>
    resolve(h.datastorePath) === datastore
  );
  return handle?.commitStore.highWaterMark().cursor ?? -1;
}

/**
 * a claim moves no high-water mark, so the command counts it as a change for
 * the closing sync's report, and serve confirms it replicated before it
 * answers, which no commit mark would make it do
 */
export function v3ClaimCommitLog(
  repoDir: string,
  config: V3DatastoreConfig,
  options: { readonly confirmReplicated?: boolean } = {},
): {
  owner(): DatastoreOwner | undefined;
  catchUp(signal: AbortSignal): Promise<void>;
  highWaterCursor(): number;
  claim(owner: DatastoreOwner): Promise<void>;
  release(): Promise<void>;
  confirm(): Promise<void>;
} {
  const handle = v3DatastoreFor(repoDir, config);
  const fence = (): number => {
    const held = v3WriterFence(config.path);
    if (held === undefined) {
      throw markErrorPaths(
        new Error(
          `Internal error: the claim on the v3 datastore at ${config.path} ` +
            "was changed without its writer lease",
        ),
        [config.path],
      );
    }
    // As before a commit: a hold that was lost, or a copy that is not
    // current (serve's restore after a retake), writes no claim, which the
    // restore would drop.
    assertV3WriterCurrent(config.path);
    if (
      v3ReplicatesAt(config.path) &&
      !currentCopies.has(handleKey(repoDir, config))
    ) {
      throw new WriterFencedError(held, undefined, "copy-restoring");
    }
    return held;
  };
  const confirm = async (): Promise<void> => {
    if (options.confirmReplicated === true && v3ReplicatesAt(config.path)) {
      await syncForRequests(resolve(config.path), 1);
    }
  };
  const changed = async (): Promise<void> => {
    const datastore = resolve(config.path);
    const start = commandStartMarks.get(datastore);
    if (start !== undefined) {
      commandStartMarks.set(datastore, { ...start, mark: -1 });
    }
    await confirm();
  };
  return {
    owner: () => handle.commitStore.owner(),
    catchUp: (signal) => handle.catchUp(signal),
    highWaterCursor: () => handle.commitStore.highWaterMark().cursor,
    async claim(owner) {
      await handle.commitStore.claimOwner(fence(), owner);
      await changed();
    },
    async release() {
      await handle.commitStore.releaseOwner(fence());
      await changed();
    },
    confirm,
  };
}

async function syncForRequests(
  datastore: string,
  covering: number,
): Promise<number | undefined> {
  const use = replications.get(datastore)?.[0];
  if (use === undefined) {
    // Released for a replacement, never got back, or closed: nothing can
    // confirm the commits until a sidecar is held again.
    throw new V3ReplicationError(
      `no Litestream sidecar is held for the v3 datastore at ${datastore}`,
    );
  }
  // Requests queued behind a running sync mean several writers at once: pace
  // the head before the bucket refuses its rewrites, which a provider's own
  // retries otherwise hide.
  if (covering > 1) {
    const handle = [...opened.values()].find((h) =>
      resolve(h.datastorePath) === datastore
    );
    const writerFence = handle === undefined
      ? undefined
      : v3WriterFence(handle.datastorePath);
    if (writerFence !== undefined) {
      headPacerFor(datastore, use.lineageFence, writerFence)?.contended(
        Date.now(),
      );
    }
  }
  return await syncAndPublish(
    datastore,
    use,
    [...opened.values()],
    v3RequestSyncDeadlineMs(),
  );
}

/**
 * not reset when serve's lineage restarts: a restarted lineage's first head is
 * published by the retake's first sync or the next commit, and until then the
 * previous lineage holds the same commits
 */
const publishedMarks = new Map<string, number>();

const publishListeners = new Map<string, Set<() => void>>();

export interface V3CommitFeedSource {
  readonly datastore: V3Datastore;
  /**
   * a replicating datastore's writer sends only what it published: an
   * unreplicated commit could be lost to a failover and leave a follower
   * holding a commit the next leader never had
   */
  bound(): number;
  onMoved(listener: (replaced: boolean) => void): () => void;
}

export function v3CommitFeedSource(
  repoDir: string,
  config: V3DatastoreConfig,
): V3CommitFeedSource {
  const datastore = v3DatastoreFor(repoDir, config);
  const key = resolve(config.path);
  return {
    datastore,
    bound() {
      const head = datastore.commitStore.highWaterMark().cursor;
      if (
        !v3ReplicatesAt(config.path) ||
        !holdsCurrentV3WriterLease(config.path)
      ) {
        return head;
      }
      return Math.min(head, publishedMarks.get(key) ?? 0);
    },
    onMoved(listener) {
      const offHead = datastore.commitStore.onHeadMoved(listener);
      let listeners = publishListeners.get(key);
      if (listeners === undefined) {
        listeners = new Set();
        publishListeners.set(key, listeners);
      }
      const published = () => listener(false);
      listeners.add(published);
      return () => {
        offHead();
        publishListeners.get(key)?.delete(published);
      };
    },
  };
}

export const SERVE_REPLICATION_PROBE_INTERVAL_MS = 30_000;

function leaseLost(datastorePath: string): boolean {
  try {
    assertV3WriterCurrent(datastorePath);
    return false;
  } catch (error) {
    if (error instanceof WriterFencedError) return true;
    throw error;
  }
}

export interface V3ReplicationUpkeep {
  /**
   * a replacement that ends after a bounded wait releases what it acquired
   * rather than keep it
   */
  stop(options?: { readonly waitMs?: number }): Promise<void>;
}

/**
 * two triggers replace it, serve retaking the lease at a new fence and a probe
 * finding the sidecar not answering; both go through one replacement at a time,
 * none starts once stopping has begun
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
  // Aborted once a bounded stop() stops waiting: a probe's sync is given up,
  // and a replacement still running keeps nothing it acquires.
  const stopping = new AbortController();
  let replacing: Promise<void> | undefined;
  let probing: Promise<void> | undefined;
  // Each retake counts, so a replacement knows one came while it ran; the
  // fence it announced is the retake's even before the lease records it.
  let retakes = 0;
  let announced = 0;
  // a replacement asked for while one runs runs again once the running one
  // settles, instead of being dropped
  let again = false;
  // moves away from broken lineages, at most one per outage
  const lineageMoves = new BrokenLineageMoveGuard();
  const replace = (): void => {
    if (stopped) return;
    if (replacing !== undefined) {
      again = true;
      return;
    }
    const startedAt = retakes;
    // a bounded stop() that gave up ends the replacement at its next checkpoint
    // too: teardown is closing the stores it would touch
    const stale = () => retakes !== startedAt || stopping.signal.aborted;
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
      // a retake may follow another writer's commits: make the copy current and
      // prepare the lineage before the sidecar is held again; a retake
      // meanwhile makes the restore stale, so nothing more runs at this fence
      const refresh = await ensureV3CopyCurrent(repoDir, config, "write", {
        stillCurrent: () => !stale(),
      });
      if (refresh.stale === true || stale()) return;
      const handle = v3DatastoreFor(repoDir, config);
      if (refresh.restored !== undefined) {
        await handle.raiseWriterFence(fence);
      }
      // what a writer between serve's two holds left
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
      if (next !== undefined && stopping.signal.aborted) {
        // stop() stopped waiting: the closing teardown may already have
        // taken the sidecars to release, so this one is never added.
        await next.release();
        return;
      }
      if (next !== undefined) {
        // Merged: a writer hold taken meanwhile keeps its own entry, which
        // the closing teardown releases.
        replications.set(key, [...(replications.get(key) ?? []), next]);
        owedReplications.delete(key);
        lineageMoves.replacementSucceeded();
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
      // a broken lineage the move did not get away from is left at the next
      // probe by retrying the replacement at the fence the move took, never by
      // moving again
      lineageMoves.replacementFailed();
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
  // runs inside the lease's renewal, so it only starts the replacement; the
  // copy stops being current at once, so nothing commits onto it or collects
  // its chunks until the replacement makes it current
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
      // a lineage the sidecar found unrestorable is restarted at the next
      // fence, once per lineage: from a copy failing its own check the lineage
      // is kept, and moving again would only fence serve's commits
      const check = await v3ReplicaCheckOf(copyOf(repoDir, config));
      const broken = check !== undefined &&
          isLineageBroken(check.verdict, check.lineageFence)
        ? check.lineageFence
        : undefined;
      const move = broken === undefined ? "none" : lineageMoves.decide(broken);
      if (move === "replace") {
        replace();
        return;
      }
      if (move === "advance") {
        logger
          .warn`The replication lineage of the v3 datastore at ${datastorePath} cannot be restored; moving serve's writer lease to a new fence to start a new lineage`;
        try {
          if (await advanceV3WriterLease(datastorePath) !== undefined) {
            lineageMoves.advanced(broken!);
          }
        } catch (error) {
          logger
            .warn`Moving serve's writer lease of the v3 datastore at ${datastorePath} to a new fence failed; the next probe retries: ${error}`;
        }
        return;
      }
      // serve's commits replicate passively; a head is published whenever the
      // last commit moved, so a takeover after serve dies keeps every commit up
      // to the last probe
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
          stopping.signal,
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
    async stop(stopOptions = {}) {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      const settle = async () => {
        await probing;
        // A rerun the settling replacement started before stopping was seen.
        while (replacing !== undefined) await replacing;
      };
      if (stopOptions.waitMs === undefined) {
        await settle();
        return;
      }
      const settling = settle();
      // Neither a probe nor a replacement rejects; handled all the same, as
      // this one is not awaited once stop() stops waiting.
      settling.catch(() => {});
      if (!await settlesWithin(settling, stopOptions.waitMs)) {
        stopping.abort(new Error("serve is shutting down"));
        logger
          .debug`Not waiting longer for the Litestream sidecar upkeep of the v3 datastore at ${datastorePath}; serve is shutting down`;
      }
    },
  };
}

/**
 * each batch commits on its own, so a backlog an upgrade leaves is folded a
 * budget at a time over the next writers rather than at the end of one command
 */
export const CLOSING_COMPACTION_BUDGET_MS = 2_000;

export const SERVE_COMPACTION_TIMEOUT_MS = 60_000;

/**
 * logs rather than throws a failure: the command's work is already committed
 * and the next writer compacts again; running out of budget is not a failure,
 * folded batches stay folded
 */
export async function compactQuietly(
  handle: V3Datastore,
  budgetMs: number,
  stop?: AbortSignal,
): Promise<void> {
  const budget = AbortSignal.timeout(budgetMs);
  try {
    const report = await handle.compactIfDue(withStop(budget, stop));
    if (report !== undefined) {
      logger
        .debug`Compacted ${report.compacted} commits of the v3 datastore at ${handle.datastorePath}`;
    }
  } catch (error) {
    if (stop?.aborted && isBudgetAbort(error, stop.reason)) {
      logger
        .debug`Compacting the v3 datastore at ${handle.datastorePath} stopped for shutdown; the next writer goes on`;
      return;
    }
    if (budget.aborted && isBudgetAbort(error, budget.reason)) {
      logger
        .debug`Compacting the v3 datastore at ${handle.datastorePath} used its ${budgetMs} ms budget; the next writer goes on`;
      return;
    }
    logger
      .warn`Compacting the v3 datastore at ${handle.datastorePath} failed; the next writer retries: ${error}`;
  }
}

function withStop(budget: AbortSignal, stop?: AbortSignal): AbortSignal {
  return stop === undefined ? budget : AbortSignal.any([budget, stop]);
}

// a layer between the signal and the throw may wrap or re-create the reason
function isBudgetAbort(error: unknown, reason: unknown): boolean {
  if (error === reason) return true;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return true;
  }
  return error instanceof Error && error.cause === reason;
}

export const SERVE_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

const SERVE_CHUNK_GC_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * the only place stored chunks are verified, so same-size damage is found while
 * serve runs; a CLI sweep verifies nothing, nor does serve on bucket storage,
 * which cannot move a damaged chunk aside
 */
export const SERVE_CHUNK_VERIFY_BYTES = 64 * 1024 * 1024;

const deferredCollections = new Set<string>();

/** logs rather than throws a failure: the next sweep retries */
export async function collectChunksQuietly(
  handle: V3Datastore,
  timeoutMs: number = SERVE_CHUNK_GC_TIMEOUT_MS,
  verifyBytes = 0,
  stop?: AbortSignal,
): Promise<ChunkCollectionReport | undefined> {
  try {
    const report = await handle.collectChunks(
      withStop(AbortSignal.timeout(timeoutMs), stop),
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
    if (stop?.aborted && isBudgetAbort(error, stop.reason)) {
      logger
        .debug`Collecting chunks of the v3 datastore at ${handle.datastorePath} stopped for shutdown; the next sweep goes on`;
      return undefined;
    }
    if (error instanceof V3ChunkCollectionDeferredError) {
      // waiting on another lineage is expected, not a failure, but it can last:
      // said once per datastore at info, so a collection that never runs can be
      // found
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

const RETENTION_COMPACTION_TIMEOUT_MS = 10 * 60 * 1000;

export interface RetentionCompaction {
  /** the earlier of the retention cutoff and the policy's last day */
  readonly bound: Date;
  readonly compactedThrough: number;
  readonly compacted: number;
  /** 0 when the sweep failed or was deferred (logged); the next sweep retries */
  readonly chunksDeleted: number;
}

/**
 * weaker than the cutoff: content a remove took away stays until the remove is
 * folded, which never happens inside the policy's last day, so call on every
 * pass. Run only while holding the writer lock
 */
export async function compactRetentionQuietly(
  handle: V3Datastore,
  cutoff: Date,
  /**
   * a CLI command passes a short one so its exit is not held up; the next pass
   * resumes
   */
  timeoutMs: number = RETENTION_COMPACTION_TIMEOUT_MS,
  stop?: AbortSignal,
): Promise<RetentionCompaction | undefined> {
  let compaction;
  try {
    compaction = await handle.compactBefore(
      cutoff,
      withStop(AbortSignal.timeout(timeoutMs), stop),
    );
  } catch (error) {
    if (stop?.aborted && isBudgetAbort(error, stop.reason)) {
      logger
        .debug`Compacting the history of the v3 datastore at ${handle.datastorePath} stopped for shutdown; the next pass resumes`;
      return undefined;
    }
    logger
      .warn`Compacting the history of the v3 datastore at ${handle.datastorePath} before the retention cutoff failed; the next pass retries: ${error}`;
    return undefined;
  }
  const compacted = compaction.report?.compacted ?? 0;
  if (compacted > 0) {
    logger
      .debug`Compacted ${compacted} commits written before ${compaction.bound.toISOString()} of the v3 datastore at ${handle.datastorePath}`;
  }
  const sweep = stop?.aborted ? undefined : await collectChunksQuietly(
    handle,
    Math.min(timeoutMs, SERVE_CHUNK_GC_TIMEOUT_MS),
    0,
    stop,
  );
  return {
    bound: compaction.bound,
    compactedThrough: compaction.compactedThrough,
    compacted,
    chunksDeleted: sweep?.deleted ?? 0,
  };
}

export interface V3RetentionHistory {
  readonly oldestCommitAt: string | null;
  /** the policy's last day always binds */
  readonly compactionBound: Date;
}

/**
 * read-only: call it after a repository context has made the checkout's copy
 * current
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

/** the next tick retries, and the reboot check still covers the files */
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
 * a CLI swamp datastore gc cannot run meanwhile because serve holds the lock;
 * runs never overlap, and stop aborts the one in flight and waits for it
 */
export class V3MaintenanceTimer {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #stopping = new AbortController();

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

  tick(): void {
    if (this.#running !== undefined) return;
    const stop = this.#stopping.signal;
    this.#running = (async () => {
      await compactQuietly(this.handle, SERVE_COMPACTION_TIMEOUT_MS, stop);
      if (stop.aborted) return;
      await collectChunksQuietly(
        this.handle,
        SERVE_CHUNK_GC_TIMEOUT_MS,
        // only storage that quarantines a damaged chunk is verified: the
        // filesystem's own _blobs/
        isChunkQuarantine(this.handle.storage) ? SERVE_CHUNK_VERIFY_BYTES : 0,
        stop,
      );
      if (stop.aborted) return;
      await syncUnsyncedQuietly(this.handle);
    })().finally(() => {
      this.#running = undefined;
    });
  }

  /**
   * other work on the same datastore (a retention pass's compaction and chunk
   * sweep) must never overlap a tick: the sweep marker is one row, and two
   * sweeps at once hide a sweep from writers. A waiter whose signal aborts
   * gives up without running fn, so shutdown never waits out a tick for it.
   */
  async runExclusive<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    while (this.#running !== undefined) {
      if (signal?.aborted) return undefined;
      await settledOrAborted(this.#running, signal);
    }
    if (signal?.aborted) return undefined;
    const work = fn();
    this.#running = work.then(() => {}, () => {}).finally(() => {
      this.#running = undefined;
    });
    return await work;
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    const stopping = this.#stopping;
    stopping.abort();
    try {
      await this.#running;
    } finally {
      // a node that leads again starts a timer whose ticks are not aborted
      if (this.#stopping === stopping) this.#stopping = new AbortController();
    }
  }
}

function settledOrAborted(
  work: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) return work;
  return new Promise((done) => {
    const finish = () => {
      signal.removeEventListener("abort", finish);
      done();
    };
    signal.addEventListener("abort", finish, { once: true });
    work.then(finish, finish);
  });
}
