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

import { V3ReplicationError } from "../domain/datastore_v3/litestream_replication.ts";
import {
  closeV3Datastores,
  drainV3OwedAtCommandEnd,
  followServeCompactionAtCommandEnd as followServeCompaction,
  reportedV3Failure,
  type V3CommandCommits,
  v3CommandCommits,
} from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { causeChainHoldsDatastoreOutage } from "../infrastructure/datastore_v3/datastore_outage.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  OWED_DRAIN_BUDGET_MS,
  type OwedDrainReport,
} from "../infrastructure/datastore_v3/lazy_hydration.ts";

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
    await close({
      storageUnreachable: causeChainHoldsDatastoreOutage(reported),
    });
  } catch {
    // Best effort: the writer lock's TTL expires if its release failed.
  }
  return reported;
}

/** never fails the command: what it leaves undone the next command resumes */
export async function followServeCompactionAtCommandEnd(
  follow: () => Promise<void> = followServeCompaction,
): Promise<void> {
  try {
    await follow();
  } catch (error) {
    getSwampLogger(["datastore", "v3"])
      .debug`Following serve's compaction at the command's end failed: ${error}`;
  }
}

/** never fails the command: a file left owed is written when first read */
export async function drainOwedAtCommandEnd(
  drain: (budgetMs: number) => Promise<OwedDrainReport> =
    drainV3OwedAtCommandEnd,
): Promise<void> {
  try {
    const { hydrated, left } = await drain(OWED_DRAIN_BUDGET_MS);
    if (hydrated > 0 || left > 0) {
      getSwampLogger(["datastore", "v3"])
        .debug`Hydrated ${hydrated} owed files at the command's end; ${left} left`;
    }
  } catch (error) {
    getSwampLogger(["datastore", "v3"])
      .debug`Hydrating owed files at the command's end failed: ${error}`;
  }
}
