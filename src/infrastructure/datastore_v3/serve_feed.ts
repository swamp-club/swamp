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
 * a replicating datastore gives each node its own copy, appended at the
 * leader's cursor; otherwise nodes share one commits.db and the feed only
 * prompts a read model catch-up. Out of order throws FeedDivergedError
 */

import { Commit } from "../../domain/datastore_v3/commit.ts";
import { FeedDivergedError } from "./sqlite_commit_store.ts";
import { holdsCurrentV3WriterLease } from "./v3_writer_lock.ts";
import { v3ReplicatesAt } from "./v3_datastore_binding.ts";
import { type V3DatastoreConfig, v3DatastoreFor } from "./v3_repo_context.ts";

export { FeedDivergedError };

export interface LeaderChange {
  readonly cursor: number;
  readonly commit: unknown;
}

export function v3FollowerCopyCursor(
  repoDir: string,
  config: V3DatastoreConfig,
): number {
  return v3DatastoreFor(repoDir, config).commitStore.highWaterMark().cursor;
}

/**
 * Applies `changes` from the leader's feed, in order, then catches the read
 * model up. Does nothing on a node that holds the writer lease: its own
 * commits are the log.
 *
 * @throws FeedDivergedError when the copy cannot take a commit in order
 */
export async function applyV3LeaderChanges(
  repoDir: string,
  config: V3DatastoreConfig,
  changes: readonly LeaderChange[],
): Promise<void> {
  if (holdsCurrentV3WriterLease(config.path)) return;
  const handle = v3DatastoreFor(repoDir, config);
  if (v3ReplicatesAt(config.path)) {
    for (const change of changes) {
      let commit: Commit;
      try {
        commit = await Commit.fromJSON(change.commit);
      } catch (error) {
        throw new FeedDivergedError(
          `the leader's commit at cursor ${change.cursor} could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (commit.namespace !== config.namespace && config.namespace) {
        throw new FeedDivergedError(
          `the leader sent a commit of namespace ${commit.namespace}`,
        );
      }
      await handle.commitStore.appendFromLeader({
        cursor: change.cursor,
        commit,
      });
    }
  }
  await handle.catchUp();
}
