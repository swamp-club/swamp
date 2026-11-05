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
 * nothing here runs unless the datastore replicates (a bucket always does, a
 * filesystem one only when the internal replica setting names one); a current
 * copy costs one listing and no download
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
  lineagesKeptForFork,
  type LineageStarted,
  mayContinueLineage,
  newestStartedFence,
  outrankingForeignLineage,
  type PublishedLineage,
  restartLineage,
} from "../../../domain/datastore_v3/published_lineage.ts";
import type { ReplicaRoot } from "../../../domain/datastore_v3/replica_root.ts";
import {
  decideLineage,
  replicaPathFor,
  type ReplicationLineage,
} from "../../../domain/datastore_v3/replication_lineage.ts";
import {
  isLineageBroken,
  type ReplicaVerification,
} from "../../../domain/datastore_v3/replica_verification.ts";
import { padFence } from "../../../domain/datastore_v3/writer_lease.ts";
import {
  parseReplicaPathFence,
  type ReplicaPathStore,
} from "../../../domain/datastore/replica_path_store.ts";
import {
  V3ChunkCollectionDeferredError,
  V3ReplicaRootMismatchError,
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
  V3RestoreError,
  type V3RestoreResult,
} from "./litestream_restorer.ts";
import {
  ensurePrivateDir,
  ensureSharedDir,
  readCopyState,
  readLineage,
  readReplicaVerification,
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
import {
  resolveV3LitestreamBinary,
  v3PrivateRoot,
  v3Replicator,
} from "./v3_replication.ts";
import { withSpan } from "../../tracing/tracer.ts";
import type { V3ReplicaPaths } from "./replica_target_resolver.ts";
import {
  replicaUnreachableAfterFailure,
  restoreWatchStoreOverride,
  restoreWhileWatched,
  V3ReplicaUnreachableError,
} from "./restore_watch.ts";

const logger = getSwampLogger(["datastore", "v3", "replication"]);

const REPLICA_PATH_TIMEOUT_MS = 60_000;

export const DEFAULT_RESTORE_DEADLINE_MS = 30 * 60 * 1000;

let restoreDeadlineMs = DEFAULT_RESTORE_DEADLINE_MS;

export function setV3RestoreDeadlineForTesting(ms: number | undefined): void {
  restoreDeadlineMs = ms ?? DEFAULT_RESTORE_DEADLINE_MS;
}

/**
 * a lease newer than this writer's was taken, so its copy may lack that
 * writer's commits and readers follow the newer lineage; nothing is started
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

export interface V3Copy {
  readonly datastorePath: string;
  readonly repoDir: string;
  readonly commitsDb: string;
}

export function lineageRegistryFor(datastorePath: string): LineageRegistry {
  return new LineageRegistry(v3ControlPlaneAt(datastorePath));
}

/** The paths beside the copy, created and trusted only when this user's. */
async function copyPaths(copy: V3Copy): Promise<ReplicationPaths> {
  await Deno.mkdir(dirname(copy.commitsDb), { recursive: true });
  const paths = await replicationPathsFor(copy.commitsDb, v3PrivateRoot());
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

export interface V3CopyRefresh {
  /**
   * the restore, when one ran, or the seed from the datastore's shared
   * commits.db when replication was first turned on
   */
  readonly restored?: V3RestoreResult & {
    readonly lineageFence?: number;
    /**
     * The commit at the read model's cursor changed: the checkout must be
     * rebuilt from the commits, removing files no commit owns.
     */
    readonly readModelMoved: boolean;
  };
}

/**
 * makes the copy current before a command reads or writes it: restores the
 * current lineage when it is missing, behind, or holds another lineage
 */
export function makeV3CopyCurrent(
  copy: V3Copy,
  options: {
    readonly mode: "read" | "write";
    readonly openStore?: SqliteCommitStore;
    readonly lockWaitMs: number;
  },
): Promise<V3CopyRefresh> {
  if (v3ReplicaFor(copy.datastorePath) === undefined) {
    return Promise.resolve({});
  }
  return withSpan("swamp.datastore.v3.copy.refresh", {
    "swamp.datastore.v3.mode": options.mode,
  }, async (span) => {
    const refresh = await makeV3CopyCurrentNow(copy, options);
    span.setAttribute(
      "swamp.datastore.v3.restored",
      refresh.restored !== undefined,
    );
    if (refresh.restored !== undefined) {
      span.setAttributes({
        "swamp.datastore.v3.exact_txid": refresh.restored.exactTxid,
        "swamp.datastore.v3.truncated": refresh.restored.truncated,
        "swamp.datastore.v3.read_model_moved": refresh.restored.readModelMoved,
      });
    }
    return refresh;
  });
}

async function makeV3CopyCurrentNow(
  copy: V3Copy,
  options: {
    readonly mode: "read" | "write";
    readonly openStore?: SqliteCommitStore;
    readonly lockWaitMs: number;
  },
): Promise<V3CopyRefresh> {
  const replica = v3ReplicaFor(copy.datastorePath);
  if (replica === undefined) return {};
  // before the copy's first read of the bucket: the datastore is known to be v3
  const binding = v3BucketBindingAt(copy.datastorePath);
  if (binding !== undefined) {
    await withSpan(
      "swamp.datastore.v3.marker.confirm",
      {},
      () => binding.confirmMarker(),
    );
  }
  const root = replicaRootOf(replica);
  const paths = await copyPaths(copy);
  const registry = lineageRegistryFor(copy.datastorePath);
  // The cheap check, without any lock: a current copy stops here.
  const published = await registry.read(root);
  refuseForeignLineage(copy, published, root);
  const first = decideLocalCopy(await localState(paths), published, root);
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
        // As the copy stands now: that process may have restored it.
        { neverRestored: copyNeverRestored(await localState(paths)) },
      );
    }
    // Another process may have restored while this one waited.
    const local = await localState(paths);
    const lineagesNow = await registry.read(root);
    refuseForeignLineage(copy, lineagesNow, root);
    const decision = decideLocalCopy(local, lineagesNow, root);
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
      const store = SqliteCommitStore.open(target, { replicated: true });
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
    // the copy's commits the restored lineage lacks are lost: its own, never
    // confirmed, when another checkout wrote first
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
    // makes the first-clone cost visible: a restore downloads the whole lineage
    // before the command runs
    logger
      .info`Restoring this checkout's copy of the v3 datastore at ${copy.datastorePath} from replication lineage ${
      padFence(decision.lineage.fence)
    }`;
    const restoreStarted = Date.now();
    const watched = watchedReplicaPaths(copy.datastorePath, root);
    let restored: V3RestoreResult;
    try {
      restored = await withSpan("swamp.datastore.v3.restore", {
        "swamp.datastore.v3.lineage": decision.lineage.fence,
        "swamp.datastore.v3.decision": decision.kind,
      }, async () =>
        await restoreWhileWatched(
          watched,
          async (signal) =>
            await restoreV3Copy({
              binary: await resolveV3LitestreamBinary(),
              replica,
              head: decision.lineage.head,
              target,
              configDir: paths.privateDir,
              install,
              deadlineMs: restoreDeadlineMs,
              ...(signal === undefined ? {} : { signal }),
            }),
        ));
    } catch (error) {
      // a replica that cannot be listed is the storage cut off: the read fails
      // with its code and the next command restores, whether the watch stopped
      // the restore or Litestream gave up first
      if (error instanceof V3ReplicaUnreachableError) throw error;
      const unreachable = await replicaUnreachableAfterFailure(
        watched,
        error,
      );
      if (unreachable !== undefined) throw unreachable;
      // A reader whose restore fails otherwise (the lineage collected while
      // it read) reads a copy restored before as it is; a writer fails, its
      // copy unchanged, and so does a reader of a copy that never was: it
      // would read as an empty datastore.
      if (options.mode === "read" && !neverRestored) {
        return refuseOrSkip("read", copy, messageOf(error), { cause: error });
      }
      // A reader's refusal carries the restore's code whatever stopped it
      // (the binary missing, the install failing).
      if (options.mode === "read" && !(error instanceof V3RestoreError)) {
        throw new V3RestoreError(messageOf(error), { cause: error });
      }
      throw error;
    }
    // if the restore moved the last applied commit (another lineage, or dropped
    // unacknowledged commits) the checkout is rebuilt and their files removed;
    // a cursor whose commit the copy lacks counts as moved
    const readModelMoved = cursor > 0 &&
      (before === undefined || txnAt(target, cursor) !== before);
    await writeCopyState(paths, {
      replicaRoot: root.value,
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
 * reports and discards the commits left in the shared commits.db's outbox once
 * replication is on: nothing raises a fence there any more, so no recovery can
 * judge them. Runs under the writer lease
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
 * seeds only when no lineage was ever confirmed and the copy is new; the first
 * sync publishes the shared commits as the first lineage, so a seed that failed
 * before confirmation leaves them for the next writer
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
      const store = SqliteCommitStore.open(paths.commitsDb, {
        replicated: true,
      });
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
 * any failure other than a missing file or no commits table is thrown, so a
 * seed is never skipped silently
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

export interface V3ReplicaCheck {
  readonly lineageFence: number;
  readonly verdict: ReplicaVerification | undefined;
}

export async function v3ReplicaCheckOf(
  copy: V3Copy,
): Promise<V3ReplicaCheck | undefined> {
  let paths: ReplicationPaths;
  try {
    paths = await replicationPathsFor(copy.commitsDb, v3PrivateRoot());
  } catch {
    return undefined;
  }
  const lineage = await readLineage(paths);
  if (lineage === undefined) return undefined;
  return {
    lineageFence: lineage.lineageFence,
    verdict: await readReplicaVerification(paths),
  };
}

/**
 * the new lineage is a full snapshot, so the copy must pass SQLite's quick
 * check first: from a damaged copy the restart would only replace one broken
 * replica with another, so the lineage is kept
 */
export async function restartsBrokenLineage(
  paths: ReplicationPaths,
  previous: ReplicationLineage,
): Promise<boolean> {
  const verdict = await readReplicaVerification(paths);
  if (!isLineageBroken(verdict, previous.lineageFence)) return false;
  const copyCheck = quickCheck(paths.commitsDb);
  if (copyCheck !== "ok") {
    logger
      .error`Replication lineage ${
      padFence(previous.lineageFence)
    } cannot be restored, and this checkout's copy of the v3 datastore at ${paths.commitsDb} fails SQLite's quick check too (${copyCheck}), so the lineage is not restarted from it. Run swamp doctor datastores.`;
    return false;
  }
  logger
    .warn`Replication lineage ${
    padFence(previous.lineageFence)
  } cannot be restored (${
    verdict!.error
  }). Starting a new lineage from this checkout's copy, which holds every commit; other checkouts restore from it once it is confirmed.`;
  return true;
}

export function quickCheck(path: string): string {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");
    const rows = db.prepare("PRAGMA quick_check").all() as {
      quick_check: string;
    }[];
    return rows.map((row) => row.quick_check).join("; ");
  } catch (error) {
    return messageOf(error);
  } finally {
    db?.close();
  }
}

/**
 * reading past a lineage another replica root started would show an empty
 * datastore, and writing would start a lineage beside it
 */
function refuseForeignLineage(
  copy: V3Copy,
  lineages: readonly PublishedLineage[],
  root: ReplicaRoot,
): void {
  const foreign = outrankingForeignLineage(lineages, root);
  if (foreign === undefined) return;
  throw new V3ReplicaRootMismatchError(
    copy.datastorePath,
    padFence(foreign.fence),
    foreign.replicaRoot,
    root.value,
  );
}

/**
 * fails a writer, or a reader of a never-restored copy, which would read as an
 * empty datastore; otherwise the reader reads the copy as last restored, with a
 * warning
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
    .warn`Reading this checkout's last restored state of the v3 datastore at ${copy.datastorePath}: it could not be brought up to date: ${reason}`;
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
 * counts the copy's commits the restored copy lacks: those above the last
 * cursor both hold the same commit at; cursors below the restored copy's oldest
 * count as shared
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

const lineageQueues = new Map<string, Promise<void>>();

/**
 * a writer lease is exclusive and each hold takes its own fence, so the only
 * decisions that can race on one copy are this process's own: serve's retake
 * beside a writer's hold at the same fence
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
 * continues the lineage only while no other writer can have written and nothing
 * was restored, else starts a new one at fence; one this hold already started
 * is kept, another context decided it first
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
      // the start names the current lineage the copy was made current to, which
      // this one continues: collection then knows its chain from a fork
      const claim = async (published: readonly PublishedLineage[]) => {
        const follows = currentLineage(published, root)?.fence;
        if (
          await registry.start({
            fence,
            holder: holderName(),
            replicaRoot: root.value,
            startedAt: new Date().toISOString(),
            ...(follows !== undefined && follows < fence ? { follows } : {}),
            chained: true,
          })
        ) {
          return;
        }
        // Claimed before: only this copy's own start, under this root, is
        // kept. Another root's at the same fence names another replica path.
        const started = await registry.started(fence);
        if (
          previous?.lineageFence !== fence ||
          !root.matches(previous.replicaRoot) ||
          typeof started !== "object" || !root.matches(started.replicaRoot)
        ) {
          throw new Error(
            `replication lineage ${padFence(fence)} was already claimed` +
              (typeof started === "object" && !root.matches(started.replicaRoot)
                ? " under another replica root"
                : "; the writer lease's records were recreated"),
          );
        }
      };
      if (
        previous !== undefined && root.matches(previous.replicaRoot) &&
        previous.lineageFence === fence && previous.lastFence === fence
      ) {
        // This hold's own lineage, begun at its fence after any restore: its
        // start is only read, and claimed again only when it is missing.
        const started = await registry.started(fence);
        if (typeof started !== "object" || !root.matches(started.replicaRoot)) {
          await claim(await registry.read(root));
        }
        return;
      }
      let lineages: PublishedLineage[] | undefined;
      if (!options.restored) {
        lineages = await registry.read(root);
        if (
          mayContinueLineage(previous, lineages, root) &&
          !await restartsBrokenLineage(paths, previous!)
        ) {
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
      // never below a lineage a newer lease started, which readers would
      // follow, nor beside one another replica root started
      lineages ??= await registry.read(root);
      refuseForeignLineage(copy, lineages, root);
      const newest = newestStartedFence(lineages, root);
      if (newest !== undefined && newest > fence) {
        throw new V3LineageOutrankedError(fence, newest);
      }
      await claim(lineages);
      await writeLineage(paths, restartLineage(previous, root, fence));
    });
  } catch (error) {
    if (error instanceof V3ReplicaRootMismatchError) throw error;
    throw new V3ReplicationError(
      `the replication lineage of this writer could not be recorded: ${
        messageOf(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * records a lease taken outside a writer's hold (a read-only command's
 * recovery, serve's retake) as a continuation of the lineage when it may;
 * anything else is left for the next writer, which restarts
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
      // Left for the writer, which restarts it from its copy.
      if (
        isLineageBroken(
          await readReplicaVerification(paths),
          previous!.lineageFence,
        )
      ) {
        return;
      }
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

const confirmedLineages = new Set<string>();

/**
 * publishes the head, then the first confirmation, then records the copy holds
 * it, before the writer checks its lease; resolves true on the first
 * confirmation, after which the caller collects replaced lineages
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
    // A lineage is confirmed once, by whichever writer gets there first:
    // once its marker is known to exist, a later sync need not ask again.
    const confirmedKey = [
      resolve(copy.datastorePath),
      root.value,
      head.lineageFence,
    ].join("\0");
    const first = confirmedLineages.has(confirmedKey) ? false : await registry
      .confirm({
        fence: head.lineageFence,
        txid: head.txid,
        confirmedAt: at,
      });
    confirmedLineages.add(confirmedKey);
    // Never backwards (copyStateAdvances): a fenced process in this
    // checkout that publishes late, on its lineage or an older one, must not
    // make the copy look behind what it holds.
    const next = {
      replicaRoot: root.value,
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

export const V3_HEAD_PRUNE_EVERY = 16;

/**
 * prunes on every Nth writer fence only, so a writing command pays a list and
 * its deletes once in that many; best-effort: a failure is logged and a later
 * writer prunes what is left
 */
export async function pruneV3Heads(
  copy: V3Copy,
  lineageFence: number,
  writerFence: number,
): Promise<void> {
  if (writerFence % V3_HEAD_PRUNE_EVERY !== 0) return;
  if (v3ReplicaFor(copy.datastorePath) === undefined) return;
  try {
    const pruned = await withSpan(
      "swamp.datastore.v3.lineage.prune",
      { "swamp.datastore.v3.lineage": lineageFence },
      async (span) => {
        const removed = await lineageRegistryFor(copy.datastorePath)
          .pruneHeads(lineageFence, writerFence);
        span.setAttribute("swamp.datastore.v3.heads_removed", removed);
        return removed;
      },
    );
    if (pruned > 0) {
      logger
        .debug`Pruned ${pruned} head(s) below writer fence ${writerFence} from replication lineage ${
        padFence(lineageFence)
      } of ${copy.datastorePath}`;
    }
  } catch (error) {
    logger
      .debug`Pruning the heads of replication lineage ${
      padFence(lineageFence)
    } of ${copy.datastorePath} failed; a later writer retries: ${error}`;
  }
}

/**
 * refuses chunk collection while another copy may still restore a lineage
 * naming chunks this one does not: a restore's truncation or an older head can
 * leave chunks only another lineage names
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
    // kept lineages wait for an operator, not for a later lineage: said on
    // every deferral, with what to do
    const kept = await v3KeptLineages(copy.datastorePath);
    if (kept.length > 0) {
      throw new V3ChunkCollectionDeferredError(
        copy.datastorePath,
        `${kept.length} replication lineage(s) (${
          kept.map((lineage) => padFence(lineage.fence)).join(", ")
        }) are kept because they may hold commits the current lineage lacks`,
        "once they are recovered and removed by hand: `swamp doctor " +
          "datastores` lists them and says how",
      );
    }
    throw new V3ChunkCollectionDeferredError(
      copy.datastorePath,
      decision.reason,
    );
  }
}

export interface V3KeptLineage {
  readonly fence: number;
  readonly replicaRoot: string;
  readonly holder: string;
  readonly startedAt: string;
}

export async function v3KeptLineages(
  datastorePath: string,
): Promise<V3KeptLineage[]> {
  const registry = lineageRegistryFor(datastorePath);
  const kept: V3KeptLineage[] = [];
  for (const fence of [...await registry.kept()].sort((a, b) => a - b)) {
    const started = await registry.started(fence);
    if (typeof started !== "object") continue;
    kept.push({
      fence,
      replicaRoot: started.replicaRoot,
      holder: started.holder,
      startedAt: started.startedAt,
    });
  }
  return kept;
}

/**
 * paths are derived from the root and a fence, never read from a record; a
 * bucket replica's are removed only through a provider store bound to this
 * root, else they and their records stay
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
  const replicaPaths = options.replicaPaths !== undefined &&
      root.matches(options.replicaPaths.root)
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
      .filter((old) => root.matches(old.replicaRoot))
      .map((old) => old.fence);
    // A read fetches only the starts the current state needs: a lineage
    // another replica root started, or whose start does not parse, is left
    // alone, records included.
    const starts = new Map<number, LineageStarted>();
    const candidates: number[] = [];
    for (
      const fence of collectableLineages(lineages, abandoned, root, current)
    ) {
      const started = await registry.started(fence);
      if (
        started === "unreadable" ||
        (started !== undefined && !root.matches(started.replicaRoot))
      ) {
        continue;
      }
      if (started !== undefined) starts.set(fence, started);
      candidates.push(fence);
    }
    // the current lineage's chain, so lineages it may lack are kept, never
    // collected over; a lineage an older swamp started continues one below it
    // already read
    for (
      let at: number | undefined = current;
      at !== undefined && !starts.has(at);
    ) {
      const started = await registry.started(at);
      if (typeof started !== "object" || !root.matches(started.replicaRoot)) {
        break;
      }
      starts.set(at, started);
      at = started.chained === true ? started.follows : undefined;
    }
    const marked = await registry.kept();
    const kept = lineagesKeptForFork(starts, current, {
      complete: await registry.completeFences(),
      marked,
    });
    for (const fence of kept) {
      if (!marked.has(fence)) await registry.keep(fence);
    }
    // Said once, when a collection first keeps them; later ones keep them
    // quietly.
    if ([...kept].some((fence) => !marked.has(fence))) {
      logger
        .warn`The v3 datastore at ${copy.datastorePath} may hold commits outside its current replication lineage ${
        padFence(current)
      }: replication lineages ${
        [...kept].sort((a, b) => a - b).map(padFence).join(", ")
      } were written under different spellings of its S3 endpoint, at least one by a swamp before swamp-club#3801 that did not see the others. They are kept, never collected. If one checkout only changed its endpoint spelling, nothing is missing. Otherwise recover what you need from them; then remove their _control/lineage/ records and _litestream/ paths`;
    }
    for (const fence of candidates) {
      if (kept.has(fence)) continue;
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
          root.matches(old.replicaRoot) && !collected.has(old.fence) &&
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
 * every path is rebuilt from a parsed fence, so a name the provider listed
 * never reaches removePath as given
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
 * a file replica's path must resolve under the replica's _litestream/
 * directory; a bucket replica's is removed through the provider's store and
 * kept (false) without it
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

function watchedReplicaPaths(
  datastorePath: string,
  root: ReplicaRoot,
): ReplicaPathStore | undefined {
  const override = restoreWatchStoreOverride();
  if (override !== undefined) return override;
  const paths = v3BucketBindingAt(datastorePath)?.replicaPaths;
  return paths !== undefined && root.matches(paths.root)
    ? paths.store
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reasonOf(error: unknown): string {
  return error instanceof V3ReplicationUnavailableError
    ? error.reason
    : messageOf(error);
}
