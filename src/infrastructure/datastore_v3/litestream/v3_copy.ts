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
 * A checkout's copy of a replicated v3 datastore's `commits.db`
 * (swamp-club#3482, Phase 4 D2): kept current from the published lineage,
 * and the lineage its writer replicates published for every other copy.
 *
 * - {@link makeV3CopyCurrent}, before a command's first read or write:
 *   restores the copy when it is missing, behind, or holds another
 *   lineage. A current copy costs one control-plane listing and no
 *   download.
 * - {@link prepareV3WriterLineage}, once a writer holds the lease and its
 *   copy is current: continues its lineage only while no other writer can
 *   have written since, and otherwise starts a new one and claims it.
 * - {@link publishV3Head}, after a sync confirmed under the lease: the
 *   lineage's first confirmation, its head, and the garbage collection of
 *   the lineages it replaced.
 *
 * Nothing here runs unless the datastore replicates: a v3 datastore on a
 * bucket always does (swamp-club#3534), a filesystem one only while the
 * internal replica setting names a replica.
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "@std/path";
import { markErrorPaths, UserError } from "../../../domain/errors.ts";
import {
  collectableLineages,
  copyNeverRestored,
  copyStateAdvances,
  currentLineage,
  decideChunkCollection,
  decideLocalCopy,
  type HighWaterMark,
  mayContinueLineage,
  newestStartedFence,
  type PublishedLineage,
  restartLineage,
} from "../../../domain/datastore_v3/published_lineage.ts";
import {
  decideLineage,
  replicaPathFor,
} from "../../../domain/datastore_v3/replication_lineage.ts";
import { padFence } from "../../../domain/datastore_v3/writer_lease.ts";
import {
  parseReplicaPathFence,
  type ReplicaPathStore,
} from "../../../domain/datastore/replica_path_store.ts";
import {
  V3ChunkCollectionDeferredError,
  V3ReplicationError,
  V3ReplicationUnavailableError,
} from "../../../domain/datastore_v3/litestream_replication.ts";
import { getSwampLogger } from "../../logging/logger.ts";
import { readModelStateDir } from "../record_path_guard.ts";
import { ReadModelState } from "../read_model_state.ts";
import { SqliteCommitStore } from "../sqlite_commit_store.ts";
import { READ_MODEL_STATE_FILE } from "../sqlite_read_model.ts";
import { SqliteCommitOutbox } from "../sqlite_commit_outbox.ts";
import { v3OutboxPath, v3SharedCommitsDbPath } from "../v3_datastore.ts";
import { LineageRegistry } from "./lineage_registry.ts";
import {
  installByLink,
  restoreV3Copy,
  V3_RESTORE_FAILED_CODE,
  type V3RestoreResult,
} from "./litestream_restorer.ts";
import {
  ensurePrivateDir,
  ensureSharedDir,
  readCopyState,
  readLineage,
  type ReplicationPaths,
  replicationPathsFor,
  writeCopyState,
  writeLineage,
} from "./replication_files.ts";
import { replicaRootOf, type V3ReplicaSetting } from "./replica_setting.ts";
import {
  v3BucketBindingAt,
  v3ControlPlaneAt,
  v3ReplicaFor,
} from "../v3_datastore_binding.ts";
import { resolveV3LitestreamBinary, v3Replicator } from "./v3_replication.ts";
import type { V3ReplicaPaths } from "./replica_target_resolver.ts";

const logger = getSwampLogger(["datastore", "v3", "replication"]);

/** How long one listing or removal of a bucket replica's paths may take. */
const REPLICA_PATH_TIMEOUT_MS = 60_000;

/** How long a restore may take: about 4.5 s per GB, plus round trips. */
export const DEFAULT_RESTORE_DEADLINE_MS = 30 * 60 * 1000;

let restoreDeadlineMs = DEFAULT_RESTORE_DEADLINE_MS;

/** Test seam: the restore deadline, or undefined for the default. */
export function setV3RestoreDeadlineForTesting(ms: number | undefined): void {
  restoreDeadlineMs = ms ?? DEFAULT_RESTORE_DEADLINE_MS;
}

/**
 * A writer at `fence` would start a lineage below one another writer
 * already started (swamp-club#3565): a lease newer than this writer's was
 * taken, so its copy may lack that writer's commits, and readers follow the
 * newer lineage. Nothing is started.
 */
export class V3LineageOutrankedError extends Error {
  constructor(readonly fence: number, readonly newest: number) {
    super(
      `replication lineage ${padFence(newest)} was started by a newer ` +
        `writer than this one, at fence ${fence}`,
    );
    this.name = "V3LineageOutrankedError";
  }
}

/** A checkout's copy of a datastore's `commits.db`. */
export interface V3Copy {
  readonly datastorePath: string;
  readonly repoDir: string;
  /** `v3CommitsDbPath(datastorePath, repoDir)`. */
  readonly commitsDb: string;
}

/**
 * The registry of the datastore's published lineages, in its datastore-wide
 * control plane: the filesystem datastore's own `_control/`, or a bucket
 * datastore's provider's (swamp-club#3534).
 */
export function lineageRegistryFor(datastorePath: string): LineageRegistry {
  return new LineageRegistry(v3ControlPlaneAt(datastorePath));
}

/** The paths beside the copy, created and trusted only when this user's. */
async function copyPaths(copy: V3Copy): Promise<ReplicationPaths> {
  await Deno.mkdir(dirname(copy.commitsDb), { recursive: true });
  const paths = await replicationPathsFor(copy.commitsDb);
  if (await ensureSharedDir(paths) !== "own") {
    throw markErrorPaths(
      new UserError(
        `${paths.sharedDir} belongs to another user or is open to others; ` +
          `remove it and run the command again.`,
      ),
      [paths.sharedDir],
    );
  }
  return paths;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** What {@link makeV3CopyCurrent} did. */
export interface V3CopyRefresh {
  /**
   * The restore, when one ran, or the seed from the datastore's shared
   * `commits.db` when replication was first turned on (swamp-club#3491).
   */
  readonly restored?: V3RestoreResult & {
    /** The lineage restored; undefined for a seed. */
    readonly lineageFence?: number;
    /**
     * The commit at the read model's cursor changed: the checkout must be
     * rebuilt from the commits, removing files no commit owns.
     */
    readonly readModelMoved: boolean;
  };
}

/**
 * Makes `copy` current before a command reads or writes it: restores the
 * current lineage over it when it is missing, behind, or holds another
 * lineage. `openStore` is this process's open store on the copy, which a
 * restore updates in place; without one an existing copy is updated
 * through a store opened for the restore, and a missing one is hard-linked
 * into place, never over a file another process created meanwhile.
 *
 * Restores of one copy are serialized by `restore.lock` beside it, and the
 * copy's sidecar is stopped for the restore. A read-only command whose
 * restore cannot take the locks within `lockWaitMs`, or fails, reads a copy
 * that was restored before as it is, with a warning; a writer, or a reader
 * of a copy that never was, fails (swamp-club#3642).
 */
export async function makeV3CopyCurrent(
  copy: V3Copy,
  options: {
    readonly mode: "read" | "write";
    readonly openStore?: SqliteCommitStore;
    readonly lockWaitMs: number;
  },
): Promise<V3CopyRefresh> {
  const replica = v3ReplicaFor(copy.datastorePath);
  if (replica === undefined) return {};
  // Before the copy's first read of the bucket: the datastore is known to
  // be v3 (swamp-club#3534).
  await v3BucketBindingAt(copy.datastorePath)?.confirmMarker();
  const root = replicaRootOf(replica);
  const paths = await copyPaths(copy);
  const registry = lineageRegistryFor(copy.datastorePath);
  // The cheap check, without any lock: a current copy stops here.
  const firstLocal = await localState(paths);
  const first = decideLocalCopy(firstLocal, await registry.read(root), root);
  if (first.kind === "none") {
    // A bucket datastore has no shared commits.db to seed from.
    return options.mode === "write" &&
        v3BucketBindingAt(copy.datastorePath) === undefined
      ? await seedFromSharedDatabase(copy, paths, registry, options)
      : {};
  }
  if (first.kind === "current") return {};

  const lock = await Deno.open(paths.restoreLock, {
    read: true,
    write: true,
    create: true,
  });
  let quiesced: (() => void) | undefined;
  try {
    if (!await pollLock(lock, options.lockWaitMs)) {
      return refuseOrSkip(
        options.mode,
        copy,
        "another swamp process is restoring this checkout's copy",
        { neverRestored: copyNeverRestored(firstLocal) },
      );
    }
    // Another process may have restored while this one waited.
    const local = await localState(paths);
    const decision = decideLocalCopy(local, await registry.read(root), root);
    if (decision.kind === "none" || decision.kind === "current") return {};
    const neverRestored = copyNeverRestored(local);
    try {
      quiesced = await v3Replicator().quiesce(copy.commitsDb);
    } catch (error) {
      return refuseOrSkip(options.mode, copy, reasonOf(error), {
        cause: error,
        neverRestored,
      });
    }
    await ensurePrivateDir(paths);
    const cursor = readModelCursor(copy.repoDir);
    const before = cursor > 0 ? txnAt(paths.commitsDb, cursor) : undefined;
    const target = paths.commitsDb;
    const openStore = options.openStore;
    const intoExisting = async (temp: string) => {
      const store = SqliteCommitStore.open(target);
      try {
        await store.replaceContentFrom(temp);
      } finally {
        await store.close();
      }
    };
    // A missing copy is linked into place, never over a file: a reader that
    // stopped waiting for the restore may have created an empty one, which
    // is then updated in place instead.
    const replace = openStore !== undefined
      ? (temp: string) => openStore.replaceContentFrom(temp)
      : async (temp: string) => {
        if (!await installByLink(temp, target)) await intoExisting(temp);
      };
    // The copy's commits the restored lineage lacks are lost: its own,
    // never confirmed, when another checkout wrote first (swamp-club#3565).
    let dropped = 0;
    const install = async (temp: string) => {
      // Only a warning depends on it: a copy that cannot be read (an empty
      // file a reader created) never stops the restore.
      try {
        dropped = droppedCommits(target, temp);
      } catch (error) {
        logger
          .debug`Counting the commits a restore drops from ${target} failed: ${error}`;
      }
      await replace(temp);
    };
    // The first-clone cost, visible (swamp-club#3534): a restore downloads
    // the whole lineage before the command runs.
    logger
      .info`Restoring this checkout's copy of the v3 datastore at ${copy.datastorePath} from replication lineage ${
      padFence(decision.lineage.fence)
    }`;
    const restoreStarted = Date.now();
    let restored: V3RestoreResult;
    try {
      restored = await restoreV3Copy({
        binary: await resolveV3LitestreamBinary(),
        replica,
        head: decision.lineage.head,
        target,
        configDir: paths.privateDir,
        install,
        deadlineMs: restoreDeadlineMs,
      });
    } catch (error) {
      // A reader whose restore fails (the replica unreachable, or the
      // lineage collected while it read) reads a copy restored before as it
      // is; a writer fails, its copy unchanged, and so does a reader of a
      // copy that never was: it would read as an empty datastore.
      if (options.mode === "read" && !neverRestored) {
        return refuseOrSkip("read", copy, messageOf(error), { cause: error });
      }
      throw error;
    }
    // The commit the read model last applied is still where it was, or
    // the restore moved it (swamp-club#3482): one from another lineage, or
    // one that dropped commits never acknowledged. Then the checkout is
    // rebuilt, and the files of dropped commits removed.
    // A cursor whose commit the copy no longer stores (compacted locally,
    // or never there) cannot be matched, so it counts as moved.
    const readModelMoved = cursor > 0 &&
      (before === undefined || txnAt(target, cursor) !== before);
    await writeCopyState(paths, {
      replicaRoot: root,
      lineageFence: decision.lineage.fence,
      txid: decision.lineage.head.txid,
    });
    const restoreMs = Date.now() - restoreStarted;
    logger
      .info`Restored this checkout's copy of the v3 datastore at ${copy.datastorePath} from replication lineage ${
      padFence(decision.lineage.fence)
    } (${decision.kind}) in ${restoreMs} ms`;
    if (dropped > 0) {
      logger
        .warn`The restore of this checkout's copy of the v3 datastore at ${copy.datastorePath} from replication lineage ${
        padFence(decision.lineage.fence)
      } dropped ${dropped} commit(s) the replica never confirmed: another checkout wrote to the datastore first, so they are lost`;
    }
    return {
      restored: {
        ...restored,
        lineageFence: decision.lineage.fence,
        readModelMoved,
      },
    };
  } finally {
    quiesced?.();
    lock.close();
  }
}

/**
 * Reports and discards the commits left in the shared `commits.db`'s outbox
 * (swamp-club#3490) once replication is on: nothing raises a fence on the
 * shared store any more, so no recovery can judge them, and a copy seeded
 * from it never lands them. Runs under the writer lease.
 */
async function dropSharedOutboxEntries(sharedCommitsDb: string): Promise<void> {
  const outbox = new SqliteCommitOutbox(v3OutboxPath(sharedCommitsDb));
  try {
    if (!await outbox.hasEntries()) return;
    const { entries, unreadable } = await outbox.entries();
    await outbox.discard([
      ...entries.map((entry) => ({
        namespace: entry.commit.namespace,
        partition: entry.commit.partition.toString(),
        txnId: entry.commit.txnId,
      })),
      ...unreadable.map((entry) => entry.key),
    ]);
    const count = entries.length + unreadable.length;
    logger
      .warn`Dropped ${count} v3 commits a swamp process prepared on the datastore's shared commit store before replication was turned on, and did not land. Their changes are not in the datastore`;
  } finally {
    await outbox.close();
  }
}

/**
 * Seeds a writer's copy from the datastore's shared `commits.db` when
 * replication is turned on over a datastore that already has commits
 * (swamp-club#3491): no lineage was ever confirmed, under any replica root,
 * and the copy is new (no lineage or copy record, no commits). The writer
 * then restarts its lineage at its fence, so its first sync publishes the
 * shared commits as the first lineage and every other copy restores them.
 *
 * Runs under the writer lease, which the caller holds, and `restore.lock`.
 * Nothing writes the shared database once replication is on, and lineages
 * a writer started but never confirmed do not count, so a writer that
 * seeded and failed before its first confirmation, on any checkout, leaves
 * the next writer the same commits to seed.
 */
async function seedFromSharedDatabase(
  copy: V3Copy,
  paths: ReplicationPaths,
  registry: LineageRegistry,
  options: {
    readonly openStore?: SqliteCommitStore;
    readonly lockWaitMs: number;
  },
): Promise<V3CopyRefresh> {
  const shared = v3SharedCommitsDbPath(resolve(copy.datastorePath));
  if (resolve(shared) !== resolve(paths.commitsDb)) {
    await dropSharedOutboxEntries(shared);
  }
  const unseeded = async () =>
    resolve(shared) !== resolve(paths.commitsDb) &&
    commitsIn(paths.commitsDb) === 0 &&
    await readLineage(paths) === undefined &&
    await readCopyState(paths) === undefined &&
    !await registry.everConfirmed() && commitsIn(shared) > 0;
  if (!await unseeded()) return {};
  const lock = await Deno.open(paths.restoreLock, {
    read: true,
    write: true,
    create: true,
  });
  let quiesced: (() => void) | undefined;
  try {
    if (!await pollLock(lock, options.lockWaitMs)) {
      return refuseOrSkip(
        "write",
        copy,
        "another swamp process is restoring this checkout's copy",
      );
    }
    if (!await unseeded()) return {};
    try {
      quiesced = await v3Replicator().quiesce(copy.commitsDb);
    } catch (error) {
      return refuseOrSkip("write", copy, reasonOf(error), { cause: error });
    }
    await ensurePrivateDir(paths);
    // The checkout's read model applied the shared commits before
    // replication: it moved only if the commit at its cursor differs.
    const cursor = readModelCursor(copy.repoDir);
    const before = cursor > 0 ? txnAt(shared, cursor) : undefined;
    if (options.openStore !== undefined) {
      await options.openStore.replaceContentFrom(shared);
    } else {
      const store = SqliteCommitStore.open(paths.commitsDb);
      try {
        await store.replaceContentFrom(shared);
      } finally {
        await store.close();
      }
    }
    const readModelMoved = cursor > 0 &&
      (before === undefined || txnAt(paths.commitsDb, cursor) !== before);
    logger
      .info`Seeded this checkout's copy of the v3 datastore at ${copy.datastorePath} from its shared commits.db, the first replication lineage`;
    return { restored: { exactTxid: true, truncated: 0, readModelMoved } };
  } finally {
    quiesced?.();
    lock.close();
  }
}

/**
 * How many commits the database at `path` holds: 0 when it is missing or
 * has no commits table yet. Any other failure (busy, damaged, unreadable)
 * is thrown, so a seed is never skipped silently.
 */
function commitsIn(path: string): number {
  try {
    Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");
    return (db.prepare("SELECT count(*) AS n FROM commits").get() as {
      n: number;
    }).n;
  } catch (error) {
    if (/no such table: commits/.test(messageOf(error))) return 0;
    throw markErrorPaths(
      new UserError(
        `The v3 datastore's commits at ${path} could not be read to seed ` +
          `this checkout's copy: ${messageOf(error)}. Nothing was changed; ` +
          `run the command again.`,
      ),
      [path],
    );
  } finally {
    db?.close();
  }
}

/**
 * Fails a writer, or a reader of a copy that was never restored, which
 * would read as an empty datastore (swamp-club#3642). Otherwise the reader
 * reads the copy as this checkout last restored it, with a warning.
 */
function refuseOrSkip(
  mode: "read" | "write",
  copy: V3Copy,
  reason: string,
  options: { readonly cause?: unknown; readonly neverRestored?: boolean } = {},
): V3CopyRefresh {
  if (mode === "write" || options.neverRestored === true) {
    const error = markErrorPaths(
      new UserError(
        `This checkout's copy of the v3 datastore at ${copy.datastorePath} ` +
          `must be restored before it is ${
            mode === "write" ? "written" : "read"
          }, but ${reason}. Nothing was changed; run the command again.`,
        mode === "read" ? V3_RESTORE_FAILED_CODE : undefined,
      ),
      [copy.commitsDb],
    );
    if (options.cause !== undefined) error.cause = options.cause;
    throw error;
  }
  logger
    .warn`Reading this checkout's last restored state of the v3 datastore at ${copy.datastorePath}, because bringing it up to date failed: ${reason}`;
  return {};
}

async function localState(paths: ReplicationPaths) {
  if (!await exists(paths.commitsDb)) return undefined;
  const copy = await readCopyState(paths);
  const lineage = await readLineage(paths);
  return {
    ...(copy !== undefined ? { copy } : {}),
    ...(lineage !== undefined ? { lineage } : {}),
  };
}

async function pollLock(file: Deno.FsFile, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (!await file.tryLock(true)) {
    if (Date.now() >= until) return false;
    await new Promise((done) => setTimeout(done, 50));
  }
  return true;
}

/** The commit the read model last applied: its store-wide cursor. */
function readModelCursor(repoDir: string): number {
  const path = join(readModelStateDir(repoDir), READ_MODEL_STATE_FILE);
  try {
    Deno.statSync(path);
  } catch {
    return 0;
  }
  const state = ReadModelState.open(path);
  try {
    return state.cursor();
  } finally {
    state.close();
  }
}

/**
 * How many commits of the copy at `before` the restored copy at `after`
 * lacks: those above the last cursor both hold the same commit at, walking
 * down from the copy's newest. Cursors below the restored copy's oldest
 * (compacted away there) count as shared. Zero when there is no copy.
 */
function droppedCommits(before: string, after: string): number {
  try {
    Deno.statSync(before);
  } catch {
    return 0;
  }
  const old = new DatabaseSync(before, { readOnly: true });
  const restored = new DatabaseSync(after, { readOnly: true });
  try {
    old.exec("PRAGMA busy_timeout=5000");
    restored.exec("PRAGMA busy_timeout=5000");
    const oldest = (restored.prepare("SELECT MIN(cursor) AS c FROM commits")
      .get() as { c: number | null }).c;
    const same = restored.prepare(
      "SELECT 1 FROM commits WHERE cursor = ? AND namespace = ? " +
        "AND partition = ? AND txn_id = ?",
    );
    let dropped = 0;
    for (
      const row of old.prepare(
        "SELECT cursor, namespace, partition, txn_id FROM commits " +
          "ORDER BY cursor DESC",
      ).iterate() as Iterable<{
        cursor: number;
        namespace: string;
        partition: string;
        txn_id: string;
      }>
    ) {
      if (oldest !== null && row.cursor < oldest) break;
      if (
        same.get(row.cursor, row.namespace, row.partition, row.txn_id) !==
          undefined
      ) {
        break;
      }
      dropped++;
    }
    return dropped;
  } finally {
    restored.close();
    old.close();
  }
}

/** The txnId of the commit at `cursor`, or undefined when none is stored. */
function txnAt(path: string, cursor: number): string | undefined {
  try {
    Deno.statSync(path);
  } catch {
    return undefined;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const row = db.prepare(
      "SELECT namespace, partition, txn_id FROM commits WHERE cursor = ?",
    ).get(cursor) as
      | { namespace: string; partition: string; txn_id: string }
      | undefined;
    return row === undefined
      ? undefined
      : JSON.stringify([row.namespace, row.partition, row.txn_id]);
  } finally {
    db.close();
  }
}

function holderName(): string {
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "unknown";
  return `${user}@${Deno.hostname()}`;
}

/** Each copy's lineage decisions in this process, one at a time. */
const lineageQueues = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every lineage decision this process started on `copy`
 * (swamp-club#3491). A writer lease is exclusive and each hold takes its own
 * fence, so the only decisions that can race on one copy are this
 * process's own: serve's retake beside a writer's hold at the same fence.
 */
async function oneAtATime<T>(copy: V3Copy, fn: () => Promise<T>): Promise<T> {
  const key = resolve(copy.commitsDb);
  const run = (lineageQueues.get(key) ?? Promise.resolve()).then(fn);
  const settled = run.then(() => {}, () => {});
  lineageQueues.set(key, settled);
  try {
    return await run;
  } finally {
    if (lineageQueues.get(key) === settled) lineageQueues.delete(key);
  }
}

/**
 * Decides and records the lineage of the writer that took the lease at
 * `fence` on `copy`, which is current: continues it while no other writer
 * can have written since (its lineage is published and nothing started
 * after it) and nothing was restored, otherwise starts a new lineage at
 * `fence` and claims it. A lineage this hold already started at `fence` is
 * kept: another context in this process, or serve's retake beside a hold,
 * decided it first. Decisions on one copy run one at a time.
 *
 * @throws V3ReplicationError when the lineage cannot be recorded or claimed,
 *   or when `fence` went back to one this copy already began a lineage at
 */
export async function prepareV3WriterLineage(
  copy: V3Copy,
  fence: number,
  options: { readonly restored: boolean },
): Promise<void> {
  const replica = v3ReplicaFor(copy.datastorePath);
  if (replica === undefined) return;
  const root = replicaRootOf(replica);
  try {
    await oneAtATime(copy, async () => {
      const paths = await copyPaths(copy);
      const registry = lineageRegistryFor(copy.datastorePath);
      const previous = await readLineage(paths);
      const claim = async () => {
        if (
          await registry.start({
            fence,
            holder: holderName(),
            replicaRoot: root,
            startedAt: new Date().toISOString(),
          })
        ) {
          return;
        }
        // Claimed before: only this copy's own start, under this root, is
        // kept. Another root's at the same fence names another replica path.
        const started = await registry.started(fence);
        if (
          previous?.lineageFence !== fence || previous.replicaRoot !== root ||
          typeof started !== "object" || started.replicaRoot !== root
        ) {
          throw new Error(
            `replication lineage ${padFence(fence)} was already claimed` +
              (typeof started === "object" && started.replicaRoot !== root
                ? " under another replica root"
                : "; the writer lease's records were recreated"),
          );
        }
      };
      if (
        previous !== undefined && previous.replicaRoot === root &&
        previous.lineageFence === fence && previous.lastFence === fence
      ) {
        // This hold's own lineage, begun at its fence after any restore: its
        // start is only read, and claimed again only when it is missing.
        const started = await registry.started(fence);
        if (typeof started !== "object" || started.replicaRoot !== root) {
          await claim();
        }
        return;
      }
      let lineages: PublishedLineage[] | undefined;
      if (!options.restored) {
        lineages = await registry.read(root);
        if (mayContinueLineage(previous, lineages, root)) {
          const decided = decideLineage(previous, root, fence);
          if (decided.kind === "continue") {
            await writeLineage(paths, decided.lineage);
            return;
          }
        }
      }
      if (decideLineage(previous, root, fence).kind === "conflict") {
        // Litestream must never continue a used path over another history.
        throw new Error(
          `the writer lease went back to fence ${fence}, where this copy ` +
            `already began a replication lineage (its last fence is ` +
            `${previous?.lastFence}): the lease's records were recreated. ` +
            `Nothing was written`,
        );
      }
      // Never below a lineage a newer lease started: readers would follow
      // that one, and this writer's commits would reach none of them.
      const newest = newestStartedFence(
        lineages ?? await registry.read(root),
        root,
      );
      if (newest !== undefined && newest > fence) {
        throw new V3LineageOutrankedError(fence, newest);
      }
      await claim();
      await writeLineage(paths, restartLineage(previous, root, fence));
    });
  } catch (error) {
    throw new V3ReplicationError(
      `the replication lineage of this writer could not be recorded: ${
        messageOf(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * Records a lease this process took at `fence` outside a writer's hold (a
 * read-only command's recovery, serve's retake) as a continuation of the
 * copy's lineage, when it may continue. Anything else is left for the next
 * writer, which restarts. Best effort.
 */
export async function recordV3LeaseFence(
  copy: V3Copy,
  fence: number,
): Promise<void> {
  const replica = v3ReplicaFor(copy.datastorePath);
  if (replica === undefined) return;
  const root = replicaRootOf(replica);
  try {
    await oneAtATime(copy, async () => {
      const paths = await copyPaths(copy);
      const previous = await readLineage(paths);
      const lineages = await lineageRegistryFor(copy.datastorePath).read(root);
      if (!mayContinueLineage(previous, lineages, root)) return;
      const decided = decideLineage(previous, root, fence);
      if (decided.kind === "continue") {
        await writeLineage(paths, decided.lineage);
      }
    });
  } catch (error) {
    logger
      .debug`Recording fence ${fence} on the replication lineage of ${copy.datastorePath} failed: ${error}`;
  }
}

/**
 * Publishes what a sync Litestream confirmed covers, before the writer
 * checks its lease (swamp-club#3482): the lineage's head, then its first
 * confirmation, then records that the copy holds it. Resolves true when
 * this was the lineage's first confirmation; the caller collects the
 * lineages it replaced once the lease check passed.
 *
 * @throws V3ReplicationError when it could not be published
 */
export async function publishV3Head(
  copy: V3Copy,
  head: {
    readonly lineageFence: number;
    readonly writerFence: number;
    readonly txid: string;
    readonly mark: HighWaterMark;
  },
): Promise<boolean> {
  const replica = v3ReplicaFor(copy.datastorePath);
  if (replica === undefined) return false;
  const root = replicaRootOf(replica);
  const at = new Date().toISOString();
  const registry = lineageRegistryFor(copy.datastorePath);
  try {
    const paths = await copyPaths(copy);
    // The head first: a confirmed lineage always has one.
    await registry.publishHead({
      fence: head.lineageFence,
      txid: head.txid,
      writerFence: head.writerFence,
      mark: head.mark,
      publishedAt: at,
    });
    const first = await registry.confirm({
      fence: head.lineageFence,
      txid: head.txid,
      confirmedAt: at,
    });
    // Never backwards (copyStateAdvances): a fenced process in this
    // checkout that publishes late, on its lineage or an older one, must not
    // make the copy look behind what it holds.
    const next = {
      replicaRoot: root,
      lineageFence: head.lineageFence,
      txid: head.txid,
    };
    if (copyStateAdvances(await readCopyState(paths), next)) {
      await writeCopyState(paths, next);
    }
    return first;
  } catch (error) {
    throw new V3ReplicationError(
      `the replicated state could not be published: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

/**
 * Refuses chunk collection on `copy` while another copy may still restore
 * a lineage whose commits name chunks this one does not (swamp-club#3491):
 * a restore's truncation, or an older lineage's head, can leave chunks only
 * another lineage names. Starts the collection rules need but the read did
 * not fetch are read here. Does nothing while replication is off.
 *
 * @throws V3ChunkCollectionDeferredError when collection must wait
 */
export async function assertV3ChunksCollectable(copy: V3Copy): Promise<void> {
  const replica = v3ReplicaFor(copy.datastorePath);
  if (replica === undefined) return;
  const root = replicaRootOf(replica);
  const paths = await copyPaths(copy);
  const registry = lineageRegistryFor(copy.datastorePath);
  const read = await registry.read(root);
  const current = currentLineage(read, root)?.fence;
  const lineages: PublishedLineage[] = [];
  for (const lineage of read) {
    if (lineage.started !== undefined || lineage.fence === current) {
      lineages.push(lineage);
      continue;
    }
    const started = await registry.started(lineage.fence);
    lineages.push(
      typeof started === "object" ? { ...lineage, started } : lineage,
    );
  }
  const decision = decideChunkCollection(
    await readCopyState(paths),
    lineages,
    root,
  );
  if (decision.kind === "defer") {
    throw new V3ChunkCollectionDeferredError(
      copy.datastorePath,
      decision.reason,
    );
  }
}

/**
 * Removes the replica paths and records of the lineages the confirmed
 * lineage `current` replaced (swamp-club#3482). Only under the current
 * replica root, with every path derived from the root and a fence, never
 * read from a record. Best effort: a failure is logged, and the next
 * first confirmation tries again.
 *
 * A bucket replica's paths are removed through `replicaPaths`, the
 * provider's store (swamp-club#3531), used only when it is bound to this
 * replica's root; without it they stay, and so do their records. With it,
 * the paths of fences below `current` that no lineage key names (a fenced
 * writer's late upload after its lineage was collected) are removed too.
 */
export async function collectV3Lineages(
  copy: V3Copy,
  current: number,
  options: { readonly replicaPaths?: V3ReplicaPaths } = {},
): Promise<void> {
  const replica = v3ReplicaFor(copy.datastorePath);
  if (replica === undefined) return;
  const root = replicaRootOf(replica);
  // A store bound to another root would remove paths this registry never
  // recorded: the replica was set somewhere other than the provider's
  // target.
  const replicaPaths = options.replicaPaths?.root === root
    ? options.replicaPaths.store
    : undefined;
  if (options.replicaPaths !== undefined && replicaPaths === undefined) {
    logger
      .debug`The v3 datastore at ${copy.datastorePath} replicates outside its provider's replica target, so its old lineage paths are kept`;
  }
  const collected = new Set<number>();
  try {
    const paths = await copyPaths(copy);
    const registry = lineageRegistryFor(copy.datastorePath);
    const lineages = await registry.read(root);
    if (currentLineage(lineages, root)?.fence !== current) return;
    const own = await readLineage(paths);
    const abandoned = (own?.previousLineages ?? [])
      .filter((old) => old.replicaRoot === root)
      .map((old) => old.fence);
    for (
      const fence of collectableLineages(lineages, abandoned, root, current)
    ) {
      // A read fetches only the starts the current state needs: a lineage
      // another replica root started, or whose start does not parse, is
      // left alone, records included.
      const started = await registry.started(fence);
      if (
        started === "unreadable" ||
        (started !== undefined && started.replicaRoot !== root)
      ) {
        continue;
      }
      // One lineage that cannot be removed now (its old sidecar may still
      // be writing there) never stops the others; the next first
      // confirmation tries again.
      try {
        if (await removeReplicaPath(replica, fence, replicaPaths)) {
          await registry.remove(fence);
          collected.add(fence);
        }
      } catch (error) {
        logger
          .debug`Collecting replication lineage ${fence} of the v3 datastore at ${copy.datastorePath} failed; the next collection retries: ${error}`;
      }
    }
    if (own !== undefined) {
      // Abandoned lineages under another root are forgotten, not deleted.
      await writeLineage(paths, {
        ...own,
        previousLineages: own.previousLineages.filter((old) =>
          old.replicaRoot === root && !collected.has(old.fence) &&
          old.fence >= current
        ),
      });
    }
  } catch (error) {
    logger
      .warn`Collecting the old replication lineages of the v3 datastore at ${copy.datastorePath} failed; the next new lineage tries again: ${error}`;
    return;
  }
  if (replica.type === "file" || replicaPaths === undefined) return;
  try {
    await collectUnrecordedPaths(copy, replicaPaths, current, collected);
  } catch (error) {
    logger
      .warn`Removing unrecorded replication lineage paths of the v3 datastore at ${copy.datastorePath} failed; the next new lineage tries again: ${error}`;
  }
}

/**
 * Removes the bucket replica paths of fences below `current` that no
 * lineage key names. Every path is rebuilt from a parsed fence, so a name
 * the provider listed never reaches `removePath` as given.
 */
async function collectUnrecordedPaths(
  copy: V3Copy,
  replicaPaths: ReplicaPathStore,
  current: number,
  collected: ReadonlySet<number>,
): Promise<void> {
  const recorded = await lineageRegistryFor(copy.datastorePath).fences();
  const listed = await replicaPaths.list(
    AbortSignal.timeout(REPLICA_PATH_TIMEOUT_MS),
  );
  for (const name of listed) {
    const fence = parseReplicaPathFence(name);
    if (
      fence === undefined || fence >= current || recorded.has(fence) ||
      collected.has(fence)
    ) {
      continue;
    }
    try {
      await replicaPaths.removePath(
        padFence(fence),
        AbortSignal.timeout(REPLICA_PATH_TIMEOUT_MS),
      );
    } catch (error) {
      logger
        .debug`Removing the unrecorded replication lineage path ${fence} of the v3 datastore at ${copy.datastorePath} failed; the next collection retries: ${error}`;
    }
  }
}

/**
 * Removes the replica path of the lineage at `fence`. A file replica's
 * path must resolve under the replica's `_litestream/` directory. A bucket
 * replica's path is removed through the provider's `replicaPaths`, and is
 * kept (false) without it.
 */
async function removeReplicaPath(
  replica: V3ReplicaSetting,
  fence: number,
  replicaPaths: ReplicaPathStore | undefined,
): Promise<boolean> {
  if (replica.type !== "file") {
    if (replicaPaths === undefined) return false;
    await replicaPaths.removePath(
      padFence(fence),
      AbortSignal.timeout(REPLICA_PATH_TIMEOUT_MS),
    );
    return true;
  }
  const base = join(replica.path, "_litestream");
  const path = replicaPathFor(replica.path, fence);
  let canonicalBase: string;
  try {
    canonicalBase = await Deno.realPath(base);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
  if (!info.isDirectory || info.isSymlink) return false;
  if (resolve(await Deno.realPath(path), "..") !== canonicalBase) return false;
  // A sidecar still idling on the old lineage may add a file while the
  // directory is removed: a few attempts.
  for (let attempt = 1;; attempt++) {
    try {
      await Deno.remove(path, { recursive: true });
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return true;
      if (attempt >= 3) throw error;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why `error` refused, as a clause {@link refuseOrSkip} embeds. */
function reasonOf(error: unknown): string {
  return error instanceof V3ReplicationUnavailableError
    ? error.reason
    : messageOf(error);
}
