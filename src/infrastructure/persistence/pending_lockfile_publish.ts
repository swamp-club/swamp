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

import { atomicWriteTextFile } from "./atomic_write.ts";
import { swampPath } from "./paths.ts";

/**
 * Local record that a managed-config lockfile change failed to reach the
 * datastore (swamp-club#2752). The extension commands publish the lockfile
 * only when its content changed during the command, so without this record a
 * re-run after a failed publish would see an unchanged lockfile, skip the
 * push and exit 0 with the change still unpublished.
 *
 * It lives in the repo's own `.swamp/` directory, which is never synced, and
 * is cleared by the next successful lockfile publish or `datastore sync` push.
 */
const PENDING_FILE = "managed-config-lockfile-unpublished";

function pendingPath(repoDir: string): string {
  return swampPath(repoDir, PENDING_FILE);
}

/** Records that the lockfile has a change the datastore has not received. */
export async function markLockfilePublishPending(
  repoDir: string,
): Promise<void> {
  await atomicWriteTextFile(pendingPath(repoDir), new Date().toISOString());
}

/**
 * Whether an earlier lockfile publish failed and has not since succeeded. A
 * record that cannot be checked counts as pending, so the caller errs towards
 * publishing.
 */
export async function isLockfilePublishPending(
  repoDir: string,
): Promise<boolean> {
  try {
    await Deno.stat(pendingPath(repoDir));
    return true;
  } catch (error) {
    return !(error instanceof Deno.errors.NotFound);
  }
}

/** Clears the record once the lockfile has reached the datastore. */
export async function clearLockfilePublishPending(
  repoDir: string,
): Promise<void> {
  try {
    await Deno.remove(pendingPath(repoDir));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
