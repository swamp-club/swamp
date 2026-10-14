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
 * 4. the caller installs it: renamed into place when the copy is missing,
 *    or copied into the open copy in one transaction
 *    (`SqliteCommitStore.replaceContentFrom`), so connections that have the
 *    copy open, serve's included, keep working on the restored state.
 *
 * The source path is always derived from the replica setting and the
 * lineage's fence, never read from a record.
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "@std/path";
import { markErrorPaths, UserError } from "../../../domain/errors.ts";
import type { LineageHead } from "../../../domain/datastore_v3/published_lineage.ts";
import { replicaPathFor } from "../../../domain/datastore_v3/replication_lineage.ts";
import { padFence } from "../../../domain/datastore_v3/writer_lease.ts";
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
    let exactTxid = true;
    const exact = await runRestore(request.binary, config, temp, signal, [
      "-txid",
      request.head.txid,
    ]);
    if (exact.kind === "unavailable") {
      exactTxid = false;
      await removeDatabase(temp);
      const latest = await runRestore(
        request.binary,
        config,
        temp,
        signal,
        [],
      );
      if (latest.kind !== "ok") {
        throw new V3RestoreError(
          `litestream restore of lineage ${
            padFence(request.head.fence)
          } failed: ${
            latest.kind === "failed" ? latest.message : "no backup files"
          }`,
        );
      }
    } else if (exact.kind === "failed") {
      throw new V3RestoreError(
        `litestream restore of lineage ${
          padFence(request.head.fence)
        } failed: ${exact.message}`,
      );
    }
    checkDatabase(temp);
    const truncated = await truncateToMark(temp, request.head, target);
    await syncFile(temp);
    await request.install(temp);
    // Litestream's local state described the copy just replaced.
    await Deno.remove(
      join(dirname(target), litestreamStateDirName(basename(target))),
      { recursive: true },
    ).catch(() => {});
    return { exactTxid, truncated };
  } catch (error) {
    if (error instanceof UserError) throw error;
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

/**
 * Installs a restored temp file as `target` when no file is there: a hard
 * link, which never replaces one. Resolves false, changing nothing, when
 * `target` exists.
 */
export async function installByLink(
  temp: string,
  target: string,
): Promise<boolean> {
  try {
    await Deno.link(temp, target);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return false;
    throw error;
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

async function runRestore(
  binary: string,
  config: string,
  temp: string,
  signal: AbortSignal,
  extra: readonly string[],
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
      temp,
    ],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
    signal,
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

/** Refuses a restored file that is damaged or newer than this swamp reads. */
function checkDatabase(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as {
      integrity_check: string;
    }[];
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
      throw new V3RestoreError(
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

/** Removes a SQLite database and its WAL and shared-memory files. */
async function removeDatabase(path: string): Promise<void> {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
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
