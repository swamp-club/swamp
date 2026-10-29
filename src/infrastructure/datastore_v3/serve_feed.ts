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
 * A serve follower applying its leader's commit feed to its own copy of a
 * v3 datastore (swamp-club#4120), in place of restoring the whole published
 * lineage every tick.
 *
 * A replicating datastore gives every node its own copy: the follower
 * appends each commit at the leader's own cursor
 * ({@link SqliteCommitStore.appendFromLeader}), so cursors mean the same
 * commit on every node, then catches its read model up. A datastore that
 * does not replicate has one `commits.db` every node opens: the leader's
 * commits are already in it, so the feed only tells the follower to catch
 * its read model up.
 *
 * Anything the copy cannot take in order throws {@link FeedDivergedError}:
 * the follower stops the feed and restores from the lineage, as before.
 *
 * @module
 */

import { Commit } from "../../domain/datastore_v3/commit.ts";
import { FeedDivergedError } from "./sqlite_commit_store.ts";
import { holdsCurrentV3WriterLease } from "./v3_writer_lock.ts";
import { v3ReplicatesAt } from "./v3_datastore_binding.ts";
import { type V3DatastoreConfig, v3DatastoreFor } from "./v3_repo_context.ts";

export { FeedDivergedError };

/** One commit of the feed, as the leader sent it. */
export interface LeaderChange {
  readonly cursor: number;
  readonly commit: unknown;
}

/** The last cursor this follower's copy holds. */
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
