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

import type { DataRenameEvent, EventHandlers } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDataRenameRenderer implements Renderer<DataRenameEvent> {
  handlers(): EventHandlers<DataRenameEvent> {
    const logger = getSwampLogger(["data", "rename"]);
    return {
      renaming: () => {},
      completed: (e) => {
        const data = e.data;
        logger
          .info`Renamed ${data.oldName} -> ${data.newName} for ${data.modelName} (${data.modelType})`;
        logger
          .info`Version ${data.copiedVersion} copied as v${data.newVersion} under new name`;
        logger
          .info`Old name ${data.oldName} now forwards to ${data.newName}`;
        logger.warn`${data.warning}`;
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDataRenameRenderer implements Renderer<DataRenameEvent> {
  handlers(): EventHandlers<DataRenameEvent> {
    return {
      renaming: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDataRenameRenderer(
  mode: OutputMode,
): Renderer<DataRenameEvent> {
  switch (mode) {
    case "json":
      return new JsonDataRenameRenderer();
    case "log":
      return new LogDataRenameRenderer();
  }
}
