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
  ExtensionUndeprecateEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogExtensionUndeprecateRenderer
  implements Renderer<ExtensionUndeprecateEvent> {
  handlers(): EventHandlers<ExtensionUndeprecateEvent> {
    const logger = getSwampLogger(["extension", "undeprecate"]);
    return {
      completed: (e) => {
        logger.info("Undeprecated {name}", { name: e.data.name });
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionUndeprecateRenderer
  implements Renderer<ExtensionUndeprecateEvent> {
  handlers(): EventHandlers<ExtensionUndeprecateEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify({ undeprecated: e.data }, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionUndeprecateRenderer(
  mode: OutputMode,
): Renderer<ExtensionUndeprecateEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionUndeprecateRenderer();
    case "log":
      return new LogExtensionUndeprecateRenderer();
  }
}

export function renderExtensionUndeprecateCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    const logger = getSwampLogger(["extension", "undeprecate"]);
    logger.info("Undeprecation cancelled.");
  }
}
