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
 * The CLI's push functions (swamp-club#3055). Every push a CLI command makes
 * is one of these, passed as a root unit of work's flush or checkpoint;
 * commands never call `pushChanged` themselves. `PINNED_DIRECT_PUSHES`
 * (`integration/datastore_write_seams_rules_test.ts`) holds every
 * production `pushChanged` call to this module, the serve one, the
 * coordinator, and the deliberate exceptions.
 */

import {
  flushDatastoreSyncNamed,
  GLOBAL_LOCK_KEY,
} from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import type { RootFlushOutcome } from "../infrastructure/persistence/repo_unit_of_work.ts";

/**
 * Pushes and releases the global lock's coordinator entry when a command
 * that took the global lock ends, as the `flushDatastoreSync()` teardown in
 * `src/cli/mod.ts` did: a push error is logged at warn by the coordinator; a
 * `SyncTimeoutError` is thrown after the lock is released when the command
 * completed, and dropped when it failed, as the teardown's `catch {}` did, so
 * the command's error wins. A second call does nothing, and so does a call
 * when the command registered no global sync (a read-only or dry-run path).
 */
export async function pushGlobalLockAtEnd(
  outcome: RootFlushOutcome,
): Promise<void> {
  try {
    await flushDatastoreSyncNamed(GLOBAL_LOCK_KEY);
  } catch (error) {
    if (outcome.completed) throw error;
  }
}
