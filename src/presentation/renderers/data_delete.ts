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

import type { DataDeleteEvent, EventHandlers } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDataDeleteRenderer implements Renderer<DataDeleteEvent> {
  handlers(): EventHandlers<DataDeleteEvent> {
    const logger = getSwampLogger(["data", "delete"]);
    return {
      deleting: () => {},
      completed: (e) => {
        const data = e.data;
        if (data.version !== undefined) {
          logger
            .info`Deleted version ${data.version} of "${data.dataName}" for ${data.modelName} (${data.modelType})`;
        } else {
          logger
            .info`Deleted ${data.versionsDeleted} version(s) of "${data.dataName}" for ${data.modelName} (${data.modelType})`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDataDeleteRenderer implements Renderer<DataDeleteEvent> {
  handlers(): EventHandlers<DataDeleteEvent> {
    return {
      deleting: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDataDeleteRenderer(
  mode: OutputMode,
): Renderer<DataDeleteEvent> {
  switch (mode) {
    case "json":
      return new JsonDataDeleteRenderer();
    case "log":
      return new LogDataDeleteRenderer();
  }
}

/** Renders cancellation when user declines the prompt. */
export function renderDataDeleteCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["data", "delete"]);
    logger.info("Delete cancelled.");
  }
}
