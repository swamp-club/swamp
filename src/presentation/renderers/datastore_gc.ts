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

import type { DatastoreGcEvent } from "../../libswamp/datastores/gc.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDatastoreGcRenderer implements Renderer<DatastoreGcEvent> {
  handlers(): EventHandlers<DatastoreGcEvent> {
    const logger = getSwampLogger(["datastore", "gc"]);
    return {
      collecting: () => {
        logger.info`Collecting unreferenced content chunks...`;
      },
      completed: (e) => {
        const chunks = e.data.chunks;
        if (!e.data.applies || chunks === undefined) {
          logger
            .info`Nothing to collect: chunk garbage collection applies only to v3 datastores`;
          return;
        }
        logger
          .info`Scanned ${chunks.scanned} chunks: deleted ${chunks.deleted}, kept ${chunks.referenced} in use and ${chunks.keptTooNew} within the grace period`;
        if (chunks.keptOverBudget > 0) {
          logger
            .info`Kept ${chunks.keptOverBudget} candidates for the next run (read budget spent)`;
        }
        if (chunks.restored > 0) {
          logger
            .info`Put back ${chunks.restored} chunks a commit landed on during the sweep`;
        }
        if (chunks.damaged > 0) {
          logger
            .warn`Deleted ${chunks.damaged} damaged chunks whose bytes did not match their hash`;
        }
        if (chunks.tempFilesRemoved > 0) {
          logger.info`Removed ${chunks.tempFilesRemoved} stale temp files`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreGcRenderer implements Renderer<DatastoreGcEvent> {
  handlers(): EventHandlers<DatastoreGcEvent> {
    return {
      collecting: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDatastoreGcRenderer(
  mode: OutputMode,
): Renderer<DatastoreGcEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreGcRenderer();
    case "log":
      return new LogDatastoreGcRenderer();
  }
}
