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

import type { EventHandlers, SourcePathEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogSourcePathRenderer implements Renderer<SourcePathEvent> {
  handlers(): EventHandlers<SourcePathEvent> {
    const logger = getSwampLogger(["source"]);
    return {
      completed: (e) => {
        const data = e.data;
        if (data.status === "not_found") {
          logger.info("No source fetched. Run `swamp source fetch` first.");
        } else {
          logger.info`Version: ${data.version}`;
          logger.info`Path: ${data.path}`;
          logger.info`Files: ${data.fileCount}`;
          logger.info`Fetched: ${data.fetchedAt}`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonSourcePathRenderer implements Renderer<SourcePathEvent> {
  handlers(): EventHandlers<SourcePathEvent> {
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

export function createSourcePathRenderer(
  mode: OutputMode,
): Renderer<SourcePathEvent> {
  switch (mode) {
    case "json":
      return new JsonSourcePathRenderer();
    case "log":
      return new LogSourcePathRenderer();
  }
}
