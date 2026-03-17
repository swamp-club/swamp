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
import { getSwampLogger } from "../logging.ts";

const logger = getSwampLogger(["extension", "yank"]);

/** Data for successful extension yank. */
export interface ExtensionYankData {
  name: string;
  version: string | null;
  reason: string;
}

/**
 * Renders the successful extension yank output.
 */
export function renderExtensionYank(
  data: ExtensionYankData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ yanked: data }, null, 2));
  } else {
    if (data.version) {
      logger.info("Yanked {name}@{version}", {
        name: data.name,
        version: data.version,
      });
    } else {
      logger.info("Yanked {name} (all versions)", { name: data.name });
    }
    logger.info("Reason: {reason}", { reason: data.reason });
  }
}

/**
 * Renders a cancellation message.
 */
export function renderExtensionYankCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    logger.info("Yank cancelled.");
  }
}
