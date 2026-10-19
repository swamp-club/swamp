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

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

/** How a --hot-reload serve reloaded itself after the change. */
export interface ServerExtensionReload {
  status: "ok" | "failed";
  reloadedCount: number;
  errors: string[];
}

export interface ServerExtensionChangeData {
  /**
   * The serve instance's own reload after the change. Undefined when it
   * did not reload: it runs without --hot-reload, or predates
   * swamp-club#3594.
   */
  serveReload?: ServerExtensionReload;
  /** The command that reloads the serve instance by hand. */
  reloadCommand: string;
}

/**
 * Says whether a serve instance runs an extension change made with
 * `--server` (pull, update, install, rm). JSON mode prints the reload
 * outcome as its own document, and nothing when serve did not reload.
 */
export function renderServerExtensionChange(
  data: ServerExtensionChangeData,
  mode: OutputMode,
): void {
  const { serveReload, reloadCommand } = data;
  if (mode === "json") {
    if (serveReload) {
      // deno-lint-ignore no-console
      console.log(JSON.stringify({ serveReload }, null, 2));
    }
    return;
  }
  const logger = getSwampLogger(["cli", "remote"]);
  if (!serveReload) {
    logger
      .warn`Extension state changed on the serve instance — run ${reloadCommand} to pick up the changes`;
    return;
  }
  if (serveReload.status === "ok") {
    logger
      .info`The serve instance reloaded ${serveReload.reloadedCount} extension type(s); its next runs use the change`;
    for (const error of serveReload.errors) {
      logger.warn`Serve reload: ${error}`;
    }
    return;
  }
  logger
    .warn`The serve instance could not reload after the extension change — run ${reloadCommand} to retry: ${
    serveReload.errors.join("; ")
  }`;
}
