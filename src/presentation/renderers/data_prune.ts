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
  DataPruneEvent,
  DataPrunePreview,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDataPruneRenderer implements Renderer<DataPruneEvent> {
  handlers(): EventHandlers<DataPruneEvent> {
    const logger = getSwampLogger(["data", "prune"]);
    return {
      collecting: () => {},
      completed: (e) => {
        if (e.data.dryRun) {
          logger
            .info`Prune dry run: would reclaim ${e.data.modelsReclaimed} orphaned model(s), ${e.data.dataEntriesReclaimed} data entries, ${e.data.versionsDeleted} versions (${e.data.bytesReclaimed} bytes)`;
          return;
        }
        logger
          .info`Prune complete: reclaimed ${e.data.modelsReclaimed} orphaned model(s), ${e.data.dataEntriesReclaimed} data entries, ${e.data.versionsDeleted} versions (${e.data.bytesReclaimed} bytes)`;
        if (
          e.data.walPagesTotal > 0 &&
          e.data.walPagesCheckpointed < e.data.walPagesTotal
        ) {
          logger
            .info`WAL partial checkpoint: ${e.data.walPagesCheckpointed}/${e.data.walPagesTotal} pages (active readers present)`;
        } else if (e.data.walPagesTotal > 0) {
          logger.info`WAL checkpointed and truncated`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDataPruneRenderer implements Renderer<DataPruneEvent> {
  handlers(): EventHandlers<DataPruneEvent> {
    return {
      collecting: () => {},
      completed: (e) => {
        console.log(JSON.stringify(
          {
            modelsReclaimed: e.data.modelsReclaimed,
            dataEntriesReclaimed: e.data.dataEntriesReclaimed,
            versionsDeleted: e.data.versionsDeleted,
            bytesReclaimed: e.data.bytesReclaimed,
            dryRun: e.data.dryRun,
            reclaimedModels: e.data.reclaimedModels,
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

export function createDataPruneRenderer(
  mode: OutputMode,
): Renderer<DataPruneEvent> {
  switch (mode) {
    case "json":
      return new JsonDataPruneRenderer();
    case "log":
      return new LogDataPruneRenderer();
  }
}

/** Renders the preview of orphaned data before confirmation. */
export function renderDataPrunePreview(
  preview: DataPrunePreview,
  mode: OutputMode,
): void {
  if (mode === "json") {
    const totalVersions = preview.items.reduce(
      (sum, item) => sum + item.versionCount,
      0,
    );
    const totalBytes = preview.items.reduce(
      (sum, item) => sum + item.bytesReclaimed,
      0,
    );
    console.log(JSON.stringify(
      {
        orphanedModelCount: preview.items.length,
        orphanedVersionCount: totalVersions,
        orphanedBytes: totalBytes,
        orphanedModels: preview.items,
      },
      null,
      2,
    ));
  } else {
    const logger = getSwampLogger(["data", "prune"]);
    logger
      .info`Prune preview: ${preview.items.length} orphaned model(s) with no live definition`;
    for (const item of preview.items) {
      const name = item.modelName ? `${item.modelName} ` : "";
      logger
        .info`  ${name}(${item.type}/${item.modelId}): ${item.dataNames.length} data entries, ${item.versionCount} versions, ${item.bytesReclaimed} bytes`;
    }
  }
}

/** Renders cancellation when user declines the prompt. */
export function renderDataPruneCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["data", "prune"]);
    logger.info("Prune cancelled.");
  }
}
