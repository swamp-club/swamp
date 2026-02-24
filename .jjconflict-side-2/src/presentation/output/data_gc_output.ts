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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type {
  ExpiredDataInfo,
  LifecycleGCResult,
} from "../../domain/data/data_lifecycle_service.ts";

const logger = getSwampLogger(["data", "gc"]);

/**
 * Renders the preview of expired data before confirmation.
 */
export function renderDataGCPreview(
  expiredData: ExpiredDataInfo[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        expiredDataCount: expiredData.length,
        expiredData: expiredData.map((item) => ({
          type: item.type.toDirectoryPath(),
          modelId: item.modelId,
          dataName: item.dataName,
          reason: item.reason,
        })),
      },
      null,
      2,
    ));
  } else {
    logger.info`GC preview: ${expiredData.length} expired data items`;
  }
}

/**
 * Renders the result of garbage collection.
 */
export function renderDataGC(data: LifecycleGCResult, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        dataEntriesExpired: data.dataEntriesExpired,
        versionsDeleted: data.versionsDeleted,
        bytesReclaimed: data.bytesReclaimed,
        dryRun: data.dryRun,
        expiredEntries: data.expiredEntries,
      },
      null,
      2,
    ));
  } else {
    logger.info`GC complete: deleted ${data.dataEntriesExpired} items`;
  }
}

/**
 * Renders the cancellation message.
 */
export function renderDataGCCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    logger.info("GC cancelled.");
  }
}
