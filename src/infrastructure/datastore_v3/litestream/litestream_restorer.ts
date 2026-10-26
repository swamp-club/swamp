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
 * Restores a copy of a v3 `commits.db` from a replication lineage
 * (swamp-club#3482, Phase 4 D2).
 *
 * Litestream 0.5 restores only in full outside follow mode, so a refresh
 * is a restore too. The restore goes into a temp file beside the copy:
 *
 * 1. `litestream restore -txid <head>`: exactly the state the lineage's
 *    writer last acknowledged. A TXID inside a range compaction merged
 *    after its L0 files expired cannot be restored ("no matching backup
 *    files"), so then the latest state is restored instead;
 * 2. the result is checked: SQLite's `integrity_check`, and a schema this
 *    swamp can read;
 * 3. every commit past the head's high-water mark is removed, so a zombie
 *    writer's later uploads never land. A restore whose commits past the
 *    mark were compacted is refused;
 * 4. the caller installs it: hard-linked into place when the copy is
 *    missing, never over a file another process created meanwhile, or
 *    copied into the open copy in one transaction
 *    (`SqliteCommitStore.replaceContentFrom`), so connections that have the
 *    copy open, serve's included, keep working on the restored state.
 *
 * The source path is always derived from the replica setting and the
 * lineage's fence, never read from a record.
 *
 * @module
 */

import {
  litestreamChildEnv,
  type LitestreamReplicaType,
} from "./sidecar_env.ts";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "@std/path";
import { markErrorPaths, UserError } from "../../../domain/errors.ts";
import type { LineageHead } from "../../../domain/datastore_v3/published_lineage.ts";
import { replicaPathFor } from "../../../domain/datastore_v3/replication_lineage.ts";
import { padFence } from "../../../domain/datastore_v3/writer_lease.ts";
import { withSpan } from "../../tracing/tracer.ts";
import {
  COMMIT_STORE_SCHEMA_VERSION,
  SqliteCommitStore,
} from "../sqlite_commit_store.ts";
import {
  litestreamReplicaPath,
  litestreamStateDirName,
  renderLitestreamRestoreConfig,
} from "./replication_files.ts";
import type { V3ReplicaSetting } from "./replica_setting.ts";

/** What {@link restoreV3Copy} restores, and where. */
export interface V3RestoreRequest {
  /** The hash-checked Litestream binary. */
  readonly binary: string;
  readonly replica: V3ReplicaSetting;
  /** The lineage to restore, and its head. */
  readonly head: LineageHead;
  /** The canonical path of the copy to replace; the temp file goes beside it. */
  readonly target: string;
  /**
   * Installs the checked, truncated temp file as the copy. See
   * {@link installByRename}.
   */
  install(temp: string): Promise<void>;
  /** A private directory for the restore's config (0700). */
  readonly configDir: string;
  /** Bounds the whole restore; the child is killed past it. */
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

/** What a restore did. */
export interface V3RestoreResult {
  /** Whether the head's TXID could be restored exactly. */
  readonly exactTxid: boolean;
  /** Commits past the high-water mark that were removed. */
  readonly truncated: number;
}

/** Error code for a restore that could not run or gave no usable copy. */
export const V3_RESTORE_FAILED_CODE = "datastore_v3_restore_failed";

/** A restore that could not run or produced no usable copy. */
export class V3RestoreError extends UserError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(
      `Restoring the v3 datastore copy failed: ${message}`,
      V3_RESTORE_FAILED_CODE,
    );
    this.name = "V3RestoreError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * A restored database that failed SQLite's integrity check: the lineage
 * cannot be restored, unlike a restore that could not run (swamp-club#3935).
 */
export class V3RestoredDatabaseCorruptError extends V3RestoreError {
  constructor(message: string) {
    super(message);
    this.name = "V3RestoredDatabaseCorruptError";
  }
}

/**
 * Restores `request.head`'s lineage over `request.target`.
 *
 * @throws V3RestoreError
 */
export async function restoreV3Copy(
  request: V3RestoreRequest,
): Promise<V3RestoreResult> {
  const target = request.target;
  const temp = join(
    dirname(target),
    `.${basename(target)}.restore-${crypto.randomUUID()}`,
  );
  const config = join(request.configDir, `restore-${crypto.randomUUID()}.yml`);
  const timeout = AbortSignal.timeout(request.deadlineMs);
  const signal = request.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, request.signal]);
  try {
    const lineagePath = replicaPathFor(
      request.replica.path,
      request.head.fence,
    );
    // The config names the temp file as the database, so Litestream never
    // looks at the copy it replaces.
    await Deno.writeTextFile(
      config,
      renderLitestreamRestoreConfig(
        temp,
        request.replica,
        litestreamReplicaPath(request.replica, lineagePath),
      ),
      { mode: 0o600 },
    );
    const { exactTxid } = await restoreAndCheck({
      binary: request.binary,
      config,
      source: temp,
      temp,
      txid: request.head.txid,
      lineageFence: request.head.fence,
      replicaType: request.replica.type,
      signal,
    });
    const truncated = await withSpan(
      "swamp.datastore.v3.restore.truncate",
      {},
      () => truncateToMark(temp, request.head, target),
    );
    await withSpan("swamp.datastore.v3.restore.install", {}, async () => {
      await syncFile(temp);
      await request.install(temp);
    });
    // Litestream's local state described the copy just replaced.
    await Deno.remove(
      join(dirname(target), litestreamStateDirName(basename(target))),
      { recursive: true },
    ).catch(() => {});
    return { exactTxid, truncated };
  } catch (error) {
    if (error instanceof UserError) throw error;
    // The caller stopped the restore, and says why (swamp-club#3893).
    if (request.signal?.aborted === true) throw request.signal.reason;
    if (timeout.aborted) {
      throw new V3RestoreError(
        `it did not finish within ${Math.round(request.deadlineMs / 1000)}s`,
        { cause: error },
      );
    }
    throw new V3RestoreError(messageOf(error), { cause: error });
  } finally {
    await removeDatabase(temp).catch(() => {});
    await Deno.remove(config).catch(() => {});
  }
}

/** What {@link restoreAndCheck} restores, and where. */
export interface RestoreAndCheckRequest {
  readonly binary: string;
  /** A Litestream config naming `source` and its one replica. */
  readonly config: string;
  /** The database path the config names; the restore never touches it. */
  readonly source: string;
  /** Where the restored file is written; it must not exist. */
  readonly temp: string;
  /** The TXID to restore, as the lineage's writer acknowledged it. */
  readonly txid: string;
  /** The lineage, for messages. */
  readonly lineageFence: number;
  readonly replicaType: LitestreamReplicaType;
  readonly signal: AbortSignal;
}

/**
 * Restores a lineage into `temp` as a reader does, and checks it
 * (swamp-club#3935, shared by a reader's restore and the writer's check of
 * its own replica): at `txid`, or the latest state when compaction merged
 * that TXID's files away, then SQLite's integrity check and a schema this
 * swamp reads. Resolves with whether `txid` was restored exactly.
 *
 * @throws V3RestoreError
 */
export async function restoreAndCheck(
  request: RestoreAndCheckRequest,
): Promise<{ readonly exactTxid: boolean }> {
  const attempt = (extra: readonly string[]) =>
    runRestoreAttempt(
      request.binary,
      request.config,
      request.source,
      request.temp,
      request.signal,
      extra,
      request.replicaType,
    );
  let exactTxid = true;
  const exact = await attempt(["-txid", request.txid]);
  if (exact.kind === "unavailable") {
    exactTxid = false;
    await removeDatabase(request.temp);
    const latest = await attempt([]);
    if (latest.kind !== "ok") {
      throw new V3RestoreError(
        `litestream could not restore lineage ${
          padFence(request.lineageFence)
        }: ${latest.kind === "failed" ? latest.message : "no backup files"}`,
      );
    }
  } else if (exact.kind === "failed") {
    throw new V3RestoreError(
      `litestream could not restore lineage ${
        padFence(request.lineageFence)
      }: ${exact.message}`,
    );
  }
  await withSpan(
    "swamp.datastore.v3.restore.integrity_check",
    {},
    () => Promise.resolve(checkDatabase(request.temp)),
  );
  return { exactTxid };
}

/**
 * Installs a restored temp file as `target` when no file is there: a hard
 * link, which never replaces one. Resolves false, changing nothing, when
 * `target` exists.
 */
export async function installByLink(
  temp: string,
  target: string,
): Promise<boolean> {
  // Only the main file is linked: closing the commit store after truncation
  // checkpointed its WAL, so the temp file holds the whole database.
  try {
    await Deno.link(temp, target);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return false;
    // A filesystem without hard links: rename, unless a file appeared.
    try {
      await Deno.lstat(target);
      return false;
    } catch (missing) {
      if (!(missing instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.rename(temp, target);
  }
  await syncFile(dirname(target));
  return true;
}

/**
 * Installs a restored temp file by renaming it over `target`. Only for a
 * copy no process has open: a connection to the old file would go on with
 * it.
 */
export function installByRename(
  target: string,
): (temp: string) => Promise<void> {
  return async (temp) => {
    await removeDatabase(target);
    await Deno.rename(temp, target);
    await syncFile(dirname(target));
  };
}

type RestoreOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * One `litestream restore`, in its own span (swamp-club#3803): a restore at
 * the head's TXID that finds it compacted away runs a second, full one.
 */
function runRestoreAttempt(
  binary: string,
  config: string,
  source: string,
  temp: string,
  signal: AbortSignal,
  extra: readonly string[],
  replicaType: LitestreamReplicaType,
): Promise<RestoreOutcome> {
  return withSpan("swamp.datastore.v3.restore.attempt", {
    "swamp.datastore.v3.restore_txid": extra.length === 0
      ? "latest"
      : extra[extra.length - 1],
  }, async (span) => {
    const outcome = await runRestore(
      binary,
      config,
      source,
      temp,
      signal,
      extra,
      replicaType,
    );
    span.setAttribute("swamp.datastore.v3.restore_outcome", outcome.kind);
    return outcome;
  });
}

async function runRestore(
  binary: string,
  config: string,
  source: string,
  temp: string,
  signal: AbortSignal,
  extra: readonly string[],
  replicaType: LitestreamReplicaType,
): Promise<RestoreOutcome> {
  const result = await new Deno.Command(binary, {
    args: [
      "restore",
      "-config",
      config,
      "-no-expand-env",
      "-o",
      temp,
      ...extra,
      source,
    ],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
    signal,
    // Only what its replica needs (swamp-club#3534).
    env: litestreamChildEnv(replicaType, Deno.env.toObject()),
    clearEnv: true,
  }).output();
  if (result.success) return { kind: "ok" };
  // Killed at the deadline: the caller reports the deadline.
  if (signal.aborted) throw signal.reason;
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (/no matching backup files/i.test(stderr)) return { kind: "unavailable" };
  return {
    kind: "failed",
    message: stderr === "" ? `exit code ${result.code}` : stderr,
  };
}

/** SQLite's result codes for a damaged file: SQLITE_CORRUPT, SQLITE_NOTADB. */
const DAMAGED_FILE_CODES = new Set([11, 26]);

/**
 * Refuses a restored file that is damaged or newer than this swamp reads.
 * SQLite reports damage either as rows from its integrity check or, when
 * it cannot walk the file, by failing the check with SQLITE_CORRUPT or
 * SQLITE_NOTADB (swamp-club#3935); both are a corrupt restore.
 */
function checkDatabase(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    let rows: { integrity_check: string }[];
    try {
      rows = db.prepare("PRAGMA integrity_check").all() as {
        integrity_check: string;
      }[];
    } catch (error) {
      const code = (error as { errcode?: unknown }).errcode;
      // Extended codes (SQLITE_CORRUPT_INDEX, …) keep the primary code in
      // their low byte.
      if (typeof code === "number" && DAMAGED_FILE_CODES.has(code & 0xff)) {
        throw new V3RestoredDatabaseCorruptError(
          `the restored database failed SQLite's integrity check: ${
            messageOf(error)
          }`,
        );
      }
      throw error;
    }
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
      throw new V3RestoredDatabaseCorruptError(
        `the restored database failed SQLite's integrity check: ${
          rows.map((row) => row.integrity_check).join("; ")
        }`,
      );
    }
    const version = (db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version;
    if (version > COMMIT_STORE_SCHEMA_VERSION) {
      throw new V3RestoreError(
        `the restored database has schema version ${version}, newer than ` +
          `this swamp reads (${COMMIT_STORE_SCHEMA_VERSION}); upgrade swamp`,
      );
    }
  } finally {
    db.close();
  }
}

/** Removes every commit past the head's mark; refuses when it cannot. */
async function truncateToMark(
  path: string,
  head: LineageHead,
  target: string,
): Promise<number> {
  const store = SqliteCommitStore.open(path);
  try {
    const outcome = store.checkMark(head.mark);
    if (outcome === "compacted-past") {
      throw markErrorPaths(
        new V3RestoreError(
          `lineage ${padFence(head.fence)} holds commits past the last one ` +
            `its writer acknowledged (cursor ${head.mark.cursor}), and they ` +
            `were compacted, so they cannot be removed. A writer kept ` +
            `writing after it lost the lease. To make the lineage's last ` +
            `acknowledged state unreachable and restore the one before it, ` +
            `remove the lineage's records under _control/lineage/` +
            `${padFence(head.fence)}/ in the datastore`,
        ),
        [target],
      );
    }
    if (outcome === "mismatch") {
      throw markErrorPaths(
        new V3RestoreError(
          `the restored database does not hold the commit lineage ` +
            `${
              padFence(head.fence)
            }'s writer last acknowledged (cursor ${head.mark.cursor}); ` +
            `the replica path holds another history`,
        ),
        [target],
      );
    }
    return (await store.truncateAfter(head.mark)).removed;
  } finally {
    await store.close();
  }
}

/**
 * Removes a SQLite database, its WAL and shared-memory files, and the
 * `.tmp` file Litestream restores into before renaming it, which a restore
 * stopped part way leaves behind.
 */
async function removeDatabase(path: string): Promise<void> {
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}.tmp`]) {
    try {
      await Deno.remove(file);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

async function syncFile(path: string): Promise<void> {
  try {
    const file = await Deno.open(path, { read: true });
    try {
      await file.sync();
    } finally {
      file.close();
    }
  } catch {
    // A directory cannot be synced on every platform; the rename is still
    // atomic.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
