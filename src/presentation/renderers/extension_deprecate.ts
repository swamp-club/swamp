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

import type {
  EventHandlers,
  ExtensionDeprecateEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogExtensionDeprecateRenderer
  implements Renderer<ExtensionDeprecateEvent> {
  handlers(): EventHandlers<ExtensionDeprecateEvent> {
    const logger = getSwampLogger(["extension", "deprecate"]);
    return {
      completed: (e) => {
        logger.info("Deprecated {name}", { name: e.data.name });
        logger.info("Reason: {reason}", { reason: e.data.reason });
        if (e.data.supersededBy) {
          logger.info("Superseded by: {supersededBy}", {
            supersededBy: e.data.supersededBy,
          });
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionDeprecateRenderer
  implements Renderer<ExtensionDeprecateEvent> {
  handlers(): EventHandlers<ExtensionDeprecateEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify({ deprecated: e.data }, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionDeprecateRenderer(
  mode: OutputMode,
): Renderer<ExtensionDeprecateEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionDeprecateRenderer();
    case "log":
      return new LogExtensionDeprecateRenderer();
  }
}

export function renderExtensionDeprecateCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    const logger = getSwampLogger(["extension", "deprecate"]);
    logger.info("Deprecation cancelled.");
  }
}
