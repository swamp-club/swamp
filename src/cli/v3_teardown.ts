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
 * How the CLI's teardown closes the v3 datastores it opened.
 *
 * @module
 */

import { V3ReplicationError } from "../domain/datastore_v3/litestream_replication.ts";
import { CommitUnreachableError } from "../domain/datastore_v3/commit_log_unit_of_work.ts";
import { closeV3Datastores } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import {
  SERVE_REQUEST_SYNC_DEADLINE_MS,
  setV3SyncDeadline,
} from "../infrastructure/datastore_v3/litestream/v3_replication.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

/**
 * Closes the v3 datastores after a command that succeeded. Commits a sync
 * could not confirm fail the command (swamp-club#3416): they are saved, but
 * not yet replicated. Any other failure is only logged: the command's work
 * is committed, and the writer lock's TTL expires if its release failed.
 *
 * @throws V3ReplicationError
 */
export async function closeV3DatastoresAfterSuccess(
  close: () => Promise<void> = closeV3Datastores,
): Promise<void> {
  try {
    await close();
  } catch (error) {
    if (error instanceof V3ReplicationError) throw error;
    getSwampLogger(["datastore", "v3"])
      .warn`Closing the v3 datastore failed: ${error}`;
  }
}

/**
 * Closes the v3 datastores after a command that failed, best effort: the
 * command's error is the one reported. When it failed because its commit
 * could not reach the datastore's storage, the closing sync gets a request's
 * short deadline instead of a command's minute (swamp-club#3759): the
 * storage was just found unreachable, so waiting the full minute would only
 * delay the error, and what the sync would confirm replicates with the next
 * write either way.
 */
export async function closeV3DatastoresAfterFailure(
  error: unknown,
  close: () => Promise<void> = closeV3Datastores,
  setDeadline: (ms: number | undefined) => void = setV3SyncDeadline,
): Promise<void> {
  const unreachable = failedReachingStorage(error);
  if (unreachable) setDeadline(SERVE_REQUEST_SYNC_DEADLINE_MS);
  try {
    await close();
  } catch {
    // Best effort: the writer lock's TTL expires if its release failed.
  } finally {
    if (unreachable) setDeadline(undefined);
  }
}

/** How far {@link failedReachingStorage} follows `cause` links. */
const MAX_CAUSE_DEPTH = 8;

/** Whether `error`, or an error it wraps, is a {@link CommitUnreachableError}. */
function failedReachingStorage(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof CommitUnreachableError) return true;
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}
