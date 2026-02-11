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
