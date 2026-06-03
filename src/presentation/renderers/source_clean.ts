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

import type { EventHandlers, SourceCleanEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogSourceCleanRenderer implements Renderer<SourceCleanEvent> {
  handlers(): EventHandlers<SourceCleanEvent> {
    const logger = getSwampLogger(["source"]);
    return {
      completed: (e) => {
        const data = e.data;
        if (data.status === "not_found") {
          logger.info`No source to clean at ${data.path}`;
        } else {
          logger.info`Cleaned source at ${data.path}`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonSourceCleanRenderer implements Renderer<SourceCleanEvent> {
  handlers(): EventHandlers<SourceCleanEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createSourceCleanRenderer(
  mode: OutputMode,
): Renderer<SourceCleanEvent> {
  switch (mode) {
    case "json":
      return new JsonSourceCleanRenderer();
    case "log":
      return new LogSourceCleanRenderer();
  }
}
