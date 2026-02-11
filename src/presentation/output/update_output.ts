import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { UpdateResult } from "../../domain/update/update_service.ts";

const logger = getSwampLogger(["update"]);

/**
 * Renders the update result in the appropriate output mode.
 */
export function renderUpdateResult(
  result: UpdateResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    switch (result.status) {
      case "up_to_date":
        logger.info`swamp is up to date (${result.currentVersion})`;
        break;
      case "update_available":
        logger
          .info`Update available: ${result.currentVersion} \u2192 ${result.latestVersion}`;
        logger.info("Run `swamp update` to install");
        break;
      case "updated":
        logger.info("swamp updated successfully!");
        logger.info`${result.previousVersion} \u2192 ${result.newVersion}`;
        break;
    }
    if (result.warning) {
      logger.warn`${result.warning}`;
    }
  }
}
