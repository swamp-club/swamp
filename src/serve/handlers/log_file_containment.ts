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

import { RUN_LOG_SUBDIRS } from "../../domain/datastore/datastore_config.ts";
import {
  assertSafePath,
  PathTraversalError,
} from "../../infrastructure/persistence/safe_path.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";

/** Reads a log file's lines, as the history-logs operations do. */
export type LogFileReader = (
  path: string,
  options?: { tail?: number },
) => Promise<{ lines: string[]; path: string }>;

/**
 * Reads a run log only from the repo's own run-log directories: a method
 * run logs under outputs, a workflow step under its workflow run. The path
 * comes from the output record, which may have been written by another
 * datastore writer, so a path outside them is answered as a missing log
 * rather than read and sent to the client (swamp-club#3729).
 */
export function containedLogFileReader<R extends LogFileReader>(
  repoDir: string,
  read: R,
): R {
  const logDirs = RUN_LOG_SUBDIRS.map((subdir) => swampPath(repoDir, subdir));
  return (async (path: string, options?: { tail?: number }) => {
    for (const logDir of logDirs) {
      try {
        await assertSafePath(path, logDir);
      } catch (error) {
        if (!(error instanceof PathTraversalError)) throw error;
        continue;
      }
      return await read(path, options);
    }
    return { lines: [], path };
  }) as R;
}
