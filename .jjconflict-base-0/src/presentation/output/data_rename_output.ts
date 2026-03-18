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

const logger = getSwampLogger(["data", "rename"]);

/**
 * Data structure for the data rename output.
 */
export interface DataRenameData {
  oldName: string;
  newName: string;
  modelId: string;
  modelName: string;
  modelType: string;
  copiedVersion: number;
  newVersion: number;
  warning: string;
}

/**
 * Renders the data rename output in either log or JSON mode.
 */
export function renderDataRename(
  data: DataRenameData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger
      .info`Renamed "${data.oldName}" -> "${data.newName}" for ${data.modelName} (${data.modelType})`;
    logger
      .info`Version ${data.copiedVersion} copied as v${data.newVersion} under new name`;
    logger
      .info`Old name "${data.oldName}" now forwards to "${data.newName}"`;
    logger
      .warn`${data.warning}`;
  }
}
