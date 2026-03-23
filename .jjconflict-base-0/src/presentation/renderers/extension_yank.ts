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

import type { EventHandlers, ExtensionYankEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogExtensionYankRenderer implements Renderer<ExtensionYankEvent> {
  handlers(): EventHandlers<ExtensionYankEvent> {
    const logger = getSwampLogger(["extension", "yank"]);
    return {
      completed: (e) => {
        if (e.data.version) {
          logger.info("Yanked {name}@{version}", {
            name: e.data.name,
            version: e.data.version,
          });
        } else {
          logger.info("Yanked {name} (all versions)", { name: e.data.name });
        }
        logger.info("Reason: {reason}", { reason: e.data.reason });
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionYankRenderer implements Renderer<ExtensionYankEvent> {
  handlers(): EventHandlers<ExtensionYankEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify({ yanked: e.data }, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionYankRenderer(
  mode: OutputMode,
): Renderer<ExtensionYankEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionYankRenderer();
    case "log":
      return new LogExtensionYankRenderer();
  }
}

/** Renders cancellation when user declines the prompt. */
export function renderExtensionYankCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    const logger = getSwampLogger(["extension", "yank"]);
    logger.info("Yank cancelled.");
  }
}
