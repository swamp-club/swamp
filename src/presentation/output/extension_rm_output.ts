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

const logger = getSwampLogger(["extension", "rm"]);

/** Data for successful extension removal. */
export interface ExtensionRmData {
  name: string;
  version: string;
  filesDeleted: number;
  filesSkipped: number;
  dirsRemoved: number;
}

/**
 * Renders the successful extension removal output.
 */
export function renderExtensionRm(
  data: ExtensionRmData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ removed: data }, null, 2));
  } else {
    logger.info(
      "Removed {name} (v{version}) — deleted {count} file(s)",
      { name: data.name, version: data.version, count: data.filesDeleted },
    );
    if (data.filesSkipped > 0) {
      logger.info("{count} file(s) already missing, skipped", {
        count: data.filesSkipped,
      });
    }
    if (data.dirsRemoved > 0) {
      logger.info("Pruned {count} empty directory(ies)", {
        count: data.dirsRemoved,
      });
    }
  }
}

/**
 * Renders a single file deletion in verbose mode.
 */
export function renderExtensionRmFileDelete(
  filePath: string,
  status: "deleted" | "missing",
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ file: filePath, status }, null, 2));
  } else {
    if (status === "deleted") {
      logger.debug("  deleted {file}", { file: filePath });
    } else {
      logger.debug("  skipped {file} (already missing)", { file: filePath });
    }
  }
}

/**
 * Renders a cancellation message.
 */
export function renderExtensionRmCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    logger.info("Removal cancelled.");
  }
}

/**
 * Renders a warning about dependent extensions.
 */
export function renderExtensionRmDependencyWarning(
  dependents: string[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ dependencyWarning: dependents }, null, 2));
  } else {
    logger.warn("The following installed extensions depend on this extension:");
    for (const dep of dependents) {
      logger.warn("  {dep}", { dep });
    }
  }
}
