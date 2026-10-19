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
import type { ExtensionChangeServeReload } from "../../serve/protocol.ts";
import type { OutputMode } from "./output.ts";

export interface ServerExtensionChangeData {
  /**
   * The serve instance's own reload after the change. Undefined when it
   * did not reload: it runs without --hot-reload, or predates
   * swamp-club#3594.
   */
  serveReload?: ExtensionChangeServeReload;
  /** The command that reloads the serve instance by hand. */
  reloadCommand: string;
}

/**
 * Says whether a serve instance runs an extension change made with
 * `--server` (pull, update, install, rm). JSON mode always prints its own
 * `serveReload` document: the reload outcome, or `null` with the reload
 * command when serve did not reload.
 */
export function renderServerExtensionChange(
  data: ServerExtensionChangeData,
  mode: OutputMode,
): void {
  const { serveReload, reloadCommand } = data;
  if (mode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify(
      serveReload ? { serveReload } : { serveReload: null, reloadCommand },
      null,
      2,
    ));
    return;
  }
  const logger = getSwampLogger(["cli", "remote"]);
  if (!serveReload) {
    logger
      .warn`The serve instance did not reload after the extension change; its runs keep the old code, and remote steps of a changed type fail until it does. Restart it, or run ${reloadCommand} if it was started with --hot-reload`;
    return;
  }
  if (serveReload.status === "ok") {
    logger
      .info`Serve reloaded ${serveReload.reloadedCount} extension type(s); new runs use the updated extensions`;
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
