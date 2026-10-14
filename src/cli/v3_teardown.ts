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
import { closeV3Datastores } from "../infrastructure/datastore_v3/v3_repo_context.ts";
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
