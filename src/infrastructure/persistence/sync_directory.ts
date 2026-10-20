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
 * renamed into (swamp-club#3617).
 *
 * @module
 */

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
