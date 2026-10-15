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
 * Dormant: nothing here runs unless the internal replica setting names a
 * replica.
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "@std/path";
import { markErrorPaths, UserError } from "../../../domain/errors.ts";
import {
  collectableLineages,
  compareTxid,
  currentLineage,
  decideLocalCopy,
  type HighWaterMark,
  mayContinueLineage,
  restartLineage,
} from "../../../domain/datastore_v3/published_lineage.ts";
import {
  decideLineage,
  replicaPathFor,
} from "../../../domain/datastore_v3/replication_lineage.ts";
import { padFence } from "../../../domain/datastore_v3/writer_lease.ts";
import { V3ReplicationError } from "../../../domain/datastore_v3/litestream_replication.ts";
import { FileSystemControlPlaneStore } from "../../persistence/fs_control_plane_store.ts";
import { getSwampLogger } from "../../logging/logger.ts";
import { readModelStateDir } from "../record_path_guard.ts";
import { ReadModelState } from "../read_model_state.ts";
import { SqliteCommitStore } from "../sqlite_commit_store.ts";
import { READ_MODEL_STATE_FILE } from "../sqlite_read_model.ts";
import { LineageRegistry } from "./lineage_registry.ts";
import {
  installByLink,
  restoreV3Copy,
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
import {
  replicaRootOf,
  type V3ReplicaSetting,
  v3ReplicaSetting,
} from "./replica_setting.ts";
import { resolveV3LitestreamBinary, v3Replicator } from "./v3_replication.ts";

const logger = getSwampLogger(["datastore", "v3", "replication"]);

/** How long a restore may take: about 4.5 s per GB, plus round trips. */
export const DEFAULT_RESTORE_DEADLINE_MS = 30 * 60 * 1000;

let restoreDeadlineMs = DEFAULT_RESTORE_DEADLINE_MS;

/** Test seam: the restore deadline, or undefined for the default. */
export function setV3RestoreDeadlineForTesting(ms: number | undefined): void {
  restoreDeadlineMs = ms ?? DEFAULT_RESTORE_DEADLINE_MS;
}

/** A checkout's copy of a datastore's `commits.db`. */
export interface V3Copy {
  readonly datastorePath: string;
  readonly repoDir: string;
  /** `v3CommitsDbPath(datastorePath, repoDir)`. */
  readonly commitsDb: string;
}

/** The registry of the datastore's published lineages. */
export function lineageRegistryFor(datastorePath: string): LineageRegistry {
  return new LineageRegistry(
    new FileSystemControlPlaneStore(resolve(datastorePath)),
  );
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
  /** The restore, when one ran. */
  readonly restored?: V3RestoreResult & {
    readonly lineageFence: number;
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
 * through a store opened for the restore, and a missing one is renamed
 * into place.
 *
 * Restores of one copy are serialized by `restore.lock` beside it, and the
 * copy's sidecar is stopped for the restore. A read-only command whose
 * restore cannot take the locks within `lockWaitMs` reads the copy as it
 * is; a writer fails.
 */
export async function makeV3CopyCurrent(
  copy: V3Copy,
  options: {
    readonly mode: "read" | "write";
    readonly openStore?: SqliteCommitStore;
    readonly lockWaitMs: number;
  },
): Promise<V3CopyRefresh> {
  const replica = v3ReplicaSetting();
  if (replica === undefined) return {};
  const root = replicaRootOf(replica);
  const paths = await copyPaths(copy);
  const registry = lineageRegistryFor(copy.datastorePath);
  // The cheap check, without any lock: a current copy stops here.
  const first = decideLocalCopy(
    await localState(paths),
    await registry.read(root),
    root,
  );
  if (first.kind === "none" || first.kind === "current") return {};

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
      );
    }
    // Another process may have restored while this one waited.
    const decision = decideLocalCopy(
      await localState(paths),
      await registry.read(root),
      root,
    );
    if (decision.kind === "none" || decision.kind === "current") return {};
    try {
      quiesced = await v3Replicator().quiesce(copy.commitsDb);
    } catch (error) {
      return refuseOrSkip(options.mode, copy, messageOf(error), error);
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
    const install = openStore !== undefined
      ? (temp: string) => openStore.replaceContentFrom(temp)
      : async (temp: string) => {
        if (!await installByLink(temp, target)) await intoExisting(temp);
      };
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
      // lineage collected while it read) reads the copy as it is; a writer
      // fails, its copy unchanged.
      if (options.mode === "read") {
        return refuseOrSkip("read", copy, messageOf(error), error);
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
    logger
      .info`Restored this checkout's copy of the v3 datastore at ${copy.datastorePath} from replication lineage ${
      padFence(decision.lineage.fence)
    } (${decision.kind})`;
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

function refuseOrSkip(
  mode: "read" | "write",
  copy: V3Copy,
  reason: string,
  cause?: unknown,
): V3CopyRefresh {
  if (mode === "write") {
    const error = markErrorPaths(
      new UserError(
        `This checkout's copy of the v3 datastore at ${copy.datastorePath} ` +
          `must be restored before it is written, but ${reason}. Nothing was ` +
          `changed; run the command again.`,
      ),
      [copy.commitsDb],
    );
    if (cause !== undefined) error.cause = cause;
    throw error;
  }
  logger
    .debug`Reading this checkout's copy of the v3 datastore at ${copy.datastorePath} as it is: ${reason}`;
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

/**
 * Decides and records the lineage of the writer that took the lease at
 * `fence` on `copy`, which is current: continues it while no other writer
 * can have written since (its lineage is published and nothing started
 * after it) and nothing was restored, otherwise starts a new lineage at
 * `fence` and claims it.
 *
 * @throws V3ReplicationError when the lineage cannot be recorded or claimed
 */
export async function prepareV3WriterLineage(
  copy: V3Copy,
  fence: number,
  options: { readonly restored: boolean },
): Promise<void> {
  const replica = v3ReplicaSetting();
  if (replica === undefined) return;
  const root = replicaRootOf(replica);
  try {
    const paths = await copyPaths(copy);
    const registry = lineageRegistryFor(copy.datastorePath);
    const lineages = await registry.read(root);
    const previous = await readLineage(paths);
    if (
      !options.restored && mayContinueLineage(previous, lineages, root)
    ) {
      const decided = decideLineage(previous, root, fence);
      if (decided.kind === "continue") {
        await writeLineage(paths, decided.lineage);
        return;
      }
      if (decided.kind === "conflict") {
        logger
          .debug`The writer lease of the v3 datastore at ${copy.datastorePath} went back to fence ${fence}, where this copy's lineage began before; a new lineage starts`;
      }
    }
    const lineage = previous?.lineageFence === fence &&
        previous.replicaRoot === root
      ? previous
      : restartLineage(previous, root, fence);
    const claimed = await registry.start({
      fence,
      holder: holderName(),
      replicaRoot: root,
      startedAt: new Date().toISOString(),
    });
    if (!claimed && previous?.lineageFence !== fence) {
      throw new Error(
        `replication lineage ${padFence(fence)} was already claimed; the ` +
          `writer lease's records were recreated`,
      );
    }
    await writeLineage(paths, lineage);
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
  const replica = v3ReplicaSetting();
  if (replica === undefined) return;
  const root = replicaRootOf(replica);
  try {
    const paths = await copyPaths(copy);
    const previous = await readLineage(paths);
    const lineages = await lineageRegistryFor(copy.datastorePath).read(root);
    if (!mayContinueLineage(previous, lineages, root)) return;
    const decided = decideLineage(previous, root, fence);
    if (decided.kind === "continue") {
      await writeLineage(paths, decided.lineage);
    }
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
  const replica = v3ReplicaSetting();
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
    // Never backwards: a fenced process in this checkout that publishes late
    // must not make the copy look behind its own continued lineage.
    const held = await readCopyState(paths);
    if (
      held === undefined || held.replicaRoot !== root ||
      held.lineageFence !== head.lineageFence ||
      compareTxid(held.txid, head.txid) < 0
    ) {
      await writeCopyState(paths, {
        replicaRoot: root,
        lineageFence: head.lineageFence,
        txid: head.txid,
      });
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
 * Removes the replica paths and records of the lineages the confirmed
 * lineage `current` replaced (swamp-club#3482). Only under the current
 * replica root, with every path derived from the root and a fence, never
 * read from a record. Best effort: a failure is logged, and the next
 * first confirmation tries again.
 */
export async function collectV3Lineages(
  copy: V3Copy,
  current: number,
): Promise<void> {
  const replica = v3ReplicaSetting();
  if (replica === undefined) return;
  const root = replicaRootOf(replica);
  try {
    const paths = await copyPaths(copy);
    const registry = lineageRegistryFor(copy.datastorePath);
    const lineages = await registry.read(root);
    if (currentLineage(lineages, root)?.fence !== current) return;
    const own = await readLineage(paths);
    const abandoned = (own?.previousLineages ?? [])
      .filter((old) => old.replicaRoot === root)
      .map((old) => old.fence);
    const collected: number[] = [];
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
        if (await removeReplicaPath(replica, fence)) {
          await registry.remove(fence);
          collected.push(fence);
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
          old.replicaRoot === root && !collected.includes(old.fence) &&
          old.fence >= current
        ),
      });
    }
  } catch (error) {
    logger
      .warn`Collecting the old replication lineages of the v3 datastore at ${copy.datastorePath} failed; the next new lineage tries again: ${error}`;
  }
}

/**
 * Removes the replica path of the lineage at `fence`. A file replica's
 * path must resolve under the replica's `_litestream/` directory. An S3
 * replica's paths are collected from Phase 4E, through `storage/1`.
 */
async function removeReplicaPath(
  replica: V3ReplicaSetting,
  fence: number,
): Promise<boolean> {
  if (replica.type !== "file") return false;
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
