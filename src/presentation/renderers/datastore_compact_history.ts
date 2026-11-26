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

import type { DatastoreHistoryCompactEvent } from "../../libswamp/datastores/compact_history.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDatastoreHistoryCompactRenderer
  implements Renderer<DatastoreHistoryCompactEvent> {
  handlers(): EventHandlers<DatastoreHistoryCompactEvent> {
    const logger = getSwampLogger(["datastore", "compact"]);
    return {
      compacting: () => {
        logger.info`Compacting the datastore's commit history...`;
      },
      completed: (e) => {
        const data = e.data;
        if (!data.applies) {
          logger
            .info`Nothing to compact: history compaction applies only to v3 datastores`;
          return;
        }
        switch (data.outcome) {
          case "not_due":
            logger
              .info`Nothing to compact: ${data.eligibleCommits} commits can be folded, fewer than the ${data.minCommits} a compaction needs; the newest ${data.retainCommits} commits are always kept`;
            return;
          case "compacted":
            logger
              .info`Compacted ${data.compacted} commits of ${data.partitions} partitions in ${data.batches} batches; the compaction point is now ${data.compactedThrough}`;
            break;
          case "timed_out":
            logger
              .warn`Stopped after the ${data.budgetMs} ms budget: compacted ${data.compacted} commits of ${data.partitions} partitions in ${data.batches} batches, kept; the compaction point is now ${data.compactedThrough}. Run it again to fold the rest`;
            break;
        }
        if (data.released > 0) {
          logger
            .info`Released ${data.released} chunks for the next swamp datastore gc`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreHistoryCompactRenderer
  implements Renderer<DatastoreHistoryCompactEvent> {
  handlers(): EventHandlers<DatastoreHistoryCompactEvent> {
    return {
      compacting: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDatastoreHistoryCompactRenderer(
  mode: OutputMode,
): Renderer<DatastoreHistoryCompactEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreHistoryCompactRenderer();
    case "log":
      return new LogDatastoreHistoryCompactRenderer();
  }
}
