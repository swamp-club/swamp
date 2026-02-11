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
