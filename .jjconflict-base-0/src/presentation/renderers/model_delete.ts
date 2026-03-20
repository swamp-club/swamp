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

import type { EventHandlers, ModelDeleteEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogModelDeleteRenderer implements Renderer<ModelDeleteEvent> {
  handlers(): EventHandlers<ModelDeleteEvent> {
    const logger = getSwampLogger(["model", "delete"]);
    return {
      deleting: () => {},
      completed: (e) => {
        logger.info("Deleted model: {name} ({type})", {
          name: e.data.name,
          type: e.data.type,
        });
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonModelDeleteRenderer implements Renderer<ModelDeleteEvent> {
  handlers(): EventHandlers<ModelDeleteEvent> {
    return {
      deleting: () => {},
      completed: (e) => {
        const output = {
          deleted: {
            id: e.data.id,
            name: e.data.name,
            type: e.data.type,
            inputPath: e.data.inputPath,
          },
          resourceDeleted: e.data.resourceDeleted,
          outputsDeleted: e.data.outputsDeleted,
          evaluatedInputDeleted: e.data.evaluatedInputDeleted,
          dataDeleted: e.data.dataDeleted,
        };
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createModelDeleteRenderer(
  mode: OutputMode,
): Renderer<ModelDeleteEvent> {
  switch (mode) {
    case "json":
      return new JsonModelDeleteRenderer();
    case "log":
      return new LogModelDeleteRenderer();
  }
}

/** Renders cancellation when user declines the prompt. */
export function renderModelDeleteCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["model", "delete"]);
    logger.warn("Deletion cancelled.");
  }
}
