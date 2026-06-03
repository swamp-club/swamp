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

import type {
  EventHandlers,
  ExtensionUnyankEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogExtensionUnyankRenderer implements Renderer<ExtensionUnyankEvent> {
  handlers(): EventHandlers<ExtensionUnyankEvent> {
    const logger = getSwampLogger(["extension", "unyank"]);
    return {
      completed: (e) => {
        if (e.data.version) {
          logger.info("Unyanked {name}@{version}", {
            name: e.data.name,
            version: e.data.version,
          });
        } else {
          logger.info("Unyanked {name} (all versions)", {
            name: e.data.name,
          });
        }
        if (e.data.reason !== null) {
          logger.info("Reason: {reason}", { reason: e.data.reason });
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionUnyankRenderer implements Renderer<ExtensionUnyankEvent> {
  handlers(): EventHandlers<ExtensionUnyankEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify({ unyanked: e.data }, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionUnyankRenderer(
  mode: OutputMode,
): Renderer<ExtensionUnyankEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionUnyankRenderer();
    case "log":
      return new LogExtensionUnyankRenderer();
  }
}

export function renderExtensionUnyankCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    const logger = getSwampLogger(["extension", "unyank"]);
    logger.info("Unyank cancelled.");
  }
}
