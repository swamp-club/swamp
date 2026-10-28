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
 * Directory fsync, shared by the read model's durable writes
 * (`datastore_v3/atomic_stream_write.ts`) and the filesystem chunk storage
 * (`fs_datastore_storage.ts`), which syncs the directories its chunks were
 * renamed into (swamp-club#3617), and, as {@link syncDirectoryStrict}, the
 * durable v2 data writes (swamp-club#4017).
 *
 * @module
 */

import { markErrorPaths } from "../../domain/errors.ts";

/**
 * Fsyncs a directory so a rename or removal in it is durable. Windows cannot
 * open a directory to sync it, and some filesystems refuse; both are
 * skipped, as SQLite skips them.
 *
 * It never throws: every failure is swallowed. So the paths in
 * `FileSystemStorage` that handle a failed directory sync (`#syncAncestor`
 * forgetting a failed ancestor sync so the next caller retries it, and
 * `syncChunkDirectories` unmarking chunks it did not make durable) run only
 * with a `syncDirectory` injected through `FileSystemStorageOptions`, as
 * the tests do.
 */
export async function syncDirectory(dir: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  let handle: Deno.FsFile | undefined;
  try {
    handle = await Deno.open(dir, { read: true });
    await handle.sync();
  } catch {
    // Best effort: the file itself is already synced.
  } finally {
    handle?.close();
  }
}

/**
 * Error codes that mean a file or directory cannot be synced on this
 * platform or filesystem at all, rather than that syncing it failed:
 * a directory that cannot be opened for reading, or a filesystem that
 * refuses fsync on it. PostgreSQL's `fsync_fname` treats them the same.
 */
const SYNC_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  "EBADF",
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

/**
 * Whether a failed sync means the file or directory cannot be synced here
 * at all (`EINVAL`, `ENOTSUP`, `EOPNOTSUPP`, `EBADF`), as opposed to a sync
 * that failed, such as `EIO` or `ENOSPC`.
 */
export function isSyncUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SYNC_UNSUPPORTED_CODES.has(code);
}

/**
 * A sync that failed, naming what was being synced (swamp-club#4017). The
 * cause is the operating system's error; its message is kept in this one.
 */
export class SyncFailedError extends Error {
  constructor(
    /** The file or directory that was not synced. */
    readonly path: string,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const hint = isSyncUnsupported(cause)
      ? " This filesystem cannot sync files to disk; set `durable: false` " +
        "on the datastore in .swamp.yaml to write data without syncing it."
      : "";
    super(`Could not sync ${path} to disk: ${reason}.${hint}`, { cause });
    this.name = "SyncFailedError";
    markErrorPaths(this, [path]);
  }
}

/**
 * Fsyncs a directory and reports a failure, unlike {@link syncDirectory}:
 * the durable v2 data writes (swamp-club#4017) must not publish a version
 * whose directory entries did not reach the disk. A directory that cannot
 * be synced at all is skipped as {@link syncDirectory} skips it: Windows,
 * a directory that cannot be opened (`EACCES`, `EPERM`) or is gone
 * (`ENOENT`), and a filesystem that refuses a directory fsync (`EINVAL`,
 * `ENOTSUP`, `EBADF`). Any other failure, such as `EIO` or `ENOSPC`,
 * rejects with a {@link SyncFailedError}.
 */
export async function syncDirectoryStrict(dir: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  let handle: Deno.FsFile;
  try {
    handle = await Deno.open(dir, { read: true });
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied ||
      error instanceof Deno.errors.NotADirectory
    ) {
      return;
    }
    throw new SyncFailedError(dir, error);
  }
  try {
    await handle.sync();
  } catch (error) {
    if (isSyncUnsupported(error)) return;
    throw new SyncFailedError(dir, error);
  } finally {
    handle.close();
  }
}
