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

import type {
  DataGcEvent,
  DataGcPreview,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDataGcRenderer implements Renderer<DataGcEvent> {
  handlers(): EventHandlers<DataGcEvent> {
    const logger = getSwampLogger(["data", "gc"]);
    return {
      collecting: () => {},
      completed: (e) => {
        logger
          .info`GC complete: deleted ${e.data.dataEntriesExpired} expired items, ${e.data.versionsDeleted} excess versions reclaimed (${e.data.bytesReclaimed} bytes)`;
        if (!e.data.dryRun) {
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
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDataGcRenderer implements Renderer<DataGcEvent> {
  handlers(): EventHandlers<DataGcEvent> {
    return {
      collecting: () => {},
      completed: (e) => {
        console.log(JSON.stringify(
          {
            dataEntriesExpired: e.data.dataEntriesExpired,
            versionsDeleted: e.data.versionsDeleted,
            bytesReclaimed: e.data.bytesReclaimed,
            dryRun: e.data.dryRun,
            expiredEntries: e.data.expiredEntries,
            walPagesTotal: e.data.walPagesTotal,
            walPagesCheckpointed: e.data.walPagesCheckpointed,
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

export function createDataGcRenderer(
  mode: OutputMode,
): Renderer<DataGcEvent> {
  switch (mode) {
    case "json":
      return new JsonDataGcRenderer();
    case "log":
      return new LogDataGcRenderer();
  }
}

/** Renders the preview of expired data before confirmation. */
export function renderDataGcPreview(
  preview: DataGcPreview,
  mode: OutputMode,
): void {
  if (mode === "json") {
    const totalVersions = preview.versionGcItems.reduce(
      (sum, item) => sum + item.versionsWouldBeRemoved,
      0,
    );
    console.log(JSON.stringify(
      {
        expiredDataCount: preview.items.length,
        expiredData: preview.items,
        versionGcModelCount: preview.versionGcItems.length,
        versionGcVersionCount: totalVersions,
        versionGcData: preview.versionGcItems,
      },
      null,
      2,
    ));
  } else {
    const logger = getSwampLogger(["data", "gc"]);
    logger.info`GC preview: ${preview.items.length} expired data items`;
    if (preview.versionGcItems.length > 0) {
      const totalVersions = preview.versionGcItems.reduce(
        (sum, item) => sum + item.versionsWouldBeRemoved,
        0,
      );
      logger
        .info`version gc: ${preview.versionGcItems.length} models with ${totalVersions} excess versions`;
    }
  }
}

/** Renders cancellation when user declines the prompt. */
export function renderDataGcCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["data", "gc"]);
    logger.info("GC cancelled.");
  }
}
