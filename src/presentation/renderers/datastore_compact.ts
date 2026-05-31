// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type {
  DatastoreCompactEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDatastoreCompactRenderer implements Renderer<DatastoreCompactEvent> {
  handlers(): EventHandlers<DatastoreCompactEvent> {
    const logger = getSwampLogger(["datastore", "compact"]);
    return {
      checkpointing: () => {
        logger.info`Checkpointing WAL...`;
      },
      vacuuming: () => {
        logger.info`Vacuuming catalog database (this may take a moment)...`;
      },
      completed: (e) => {
        // wal_checkpoint(TRUNCATE) returns (0,0,0) on full success.
        if (
          e.data.walPagesTotal > 0 &&
          e.data.walPagesCheckpointed < e.data.walPagesTotal
        ) {
          logger
            .info`WAL partial checkpoint: ${e.data.walPagesCheckpointed}/${e.data.walPagesTotal} pages (active readers present)`;
        } else {
          logger.info`WAL checkpointed and truncated`;
        }
        if (e.data.vacuumSkipped) {
          logger
            .warn`Catalog rebuild skipped — WAL checkpoint still reclaimed space`;
        } else if (e.data.dbBytesReclaimed > 0) {
          logger
            .info`Catalog compacted: reclaimed ${e.data.dbBytesReclaimed} bytes`;
        } else {
          logger.info`Catalog already compact`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreCompactRenderer implements Renderer<DatastoreCompactEvent> {
  handlers(): EventHandlers<DatastoreCompactEvent> {
    return {
      checkpointing: () => {},
      vacuuming: () => {},
      completed: (e) => {
        console.log(JSON.stringify(
          {
            walPagesTotal: e.data.walPagesTotal,
            walPagesCheckpointed: e.data.walPagesCheckpointed,
            dbBytesReclaimed: e.data.dbBytesReclaimed,
            vacuumSkipped: e.data.vacuumSkipped,
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDatastoreCompactRenderer(
  mode: OutputMode,
): Renderer<DatastoreCompactEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreCompactRenderer();
    case "log":
      return new LogDatastoreCompactRenderer();
  }
}
