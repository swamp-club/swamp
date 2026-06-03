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

import type { EventHandlers, ModelEditEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogModelEditRenderer implements Renderer<ModelEditEvent> {
  handlers(): EventHandlers<ModelEditEvent> {
    const logger = getSwampLogger(["model", "edit"]);
    return {
      resolving: () => {},
      completed: (e) => {
        const data = e.data;
        if (data.status === "opened") {
          logger.info(
            "Opening {editType} file in {editor}: {name} ({type}) at {path}",
            {
              editType: data.editType,
              editor: data.editor,
              name: data.name,
              type: data.type,
              path: data.path,
            },
          );
        } else {
          logger.info(
            "Updated {editType} from stdin: {name} ({type}) at {path}",
            {
              editType: data.editType,
              name: data.name,
              type: data.type,
              path: data.path,
            },
          );
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonModelEditRenderer implements Renderer<ModelEditEvent> {
  handlers(): EventHandlers<ModelEditEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createModelEditRenderer(
  mode: OutputMode,
): Renderer<ModelEditEvent> {
  switch (mode) {
    case "json":
      return new JsonModelEditRenderer();
    case "log":
      return new LogModelEditRenderer();
  }
}
