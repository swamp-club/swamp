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

import { ServeUnreachableError } from "../infrastructure/datastore_v3/serve_upstream_errors.ts";
import { V3ReplicationError } from "../domain/datastore_v3/litestream_replication.ts";
import {
  CommitUnreachableError,
  RunPartlyCommittedError,
} from "../domain/datastore_v3/commit_log_unit_of_work.ts";
import { ReadModelCatchUpUnreachableError } from "../domain/datastore_v3/read_model.ts";
import { V3StorageUnreachableError } from "../domain/datastore_v3/writer_lease.ts";
import {
  closeV3Datastores,
  reportedV3Failure,
  type V3CommandCommits,
  v3CommandCommits,
} from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

/**
 * commits a sync could not confirm fail the command: they are saved but not yet
 * replicated. Any other failure is only logged: the command's work is committed
 * and the writer lock's TTL expires if its release failed
 */
export async function closeV3DatastoresAfterSuccess(
  close: () => Promise<void> = closeV3Datastores,
  commits: () => V3CommandCommits = v3CommandCommits,
): Promise<void> {
  // Before the close, which forgets what the command committed.
  const committed = commits();
  try {
    await close();
  } catch (error) {
    if (error instanceof V3ReplicationError) {
      throw reportedV3Failure(error, committed, { closing: true });
    }
    getSwampLogger(["datastore", "v3"])
      .warn`Closing the v3 datastore failed: ${error}`;
  }
}

/**
 * best effort. When storage could not be reached the close gets a short sync
 * deadline and stops waiting on compaction, recovery and lease retries that
 * cannot succeed; what the sync would confirm replicates with the next write
 */
export async function closeV3DatastoresAfterFailure(
  error: unknown,
  close: (
    options: { readonly storageUnreachable?: boolean },
  ) => Promise<void> = closeV3Datastores,
  commits: () => V3CommandCommits = v3CommandCommits,
): Promise<unknown> {
  // Before the close, which forgets what the command committed.
  const reported = reportedV3Failure(error, commits());
  try {
    await close({ storageUnreachable: failedReachingStorage(reported) });
  } catch {
    // Best effort: the writer lock's TTL expires if its release failed.
  }
  return reported;
}

const MAX_CAUSE_DEPTH = 8;

function failedReachingStorage(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (
      current instanceof CommitUnreachableError ||
      current instanceof RunPartlyCommittedError ||
      current instanceof V3StorageUnreachableError ||
      current instanceof ReadModelCatchUpUnreachableError ||
      // serve, which the checkout writes through, is the storage it reaches
      current instanceof ServeUnreachableError
    ) {
      return true;
    }
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}
