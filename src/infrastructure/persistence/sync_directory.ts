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

import { markErrorPaths } from "../../domain/errors.ts";

/**
 * never throws: every failure is swallowed, so the failed-sync paths in
 * FileSystemStorage run only with a syncDirectory injected through its options,
 * as in tests
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
 * codes meaning a file or directory cannot be synced on this platform or
 * filesystem at all, not that syncing failed; PostgreSQL's fsync_fname treats
 * them the same
 */
const SYNC_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  "EBADF",
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

export function isSyncUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SYNC_UNSUPPORTED_CODES.has(code);
}

export class SyncFailedError extends Error {
  constructor(
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
 * unlike syncDirectory it reports failure, since durable v2 writes must not
 * publish a version whose directory entries missed the disk; unsyncable
 * directories are skipped, other failures reject
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
