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

import type { EventHandlers, SourceFetchEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogSourceFetchRenderer implements Renderer<SourceFetchEvent> {
  handlers(): EventHandlers<SourceFetchEvent> {
    const logger = getSwampLogger(["source"]);
    return {
      fetching: () => {},
      completed: (e) => {
        const data = e.data;
        if (data.status === "already_fetched") {
          logger.info`Source already fetched: ${data.version}`;
          logger.info`Path: ${data.path}`;
          logger.info`Files: ${data.fileCount}`;
        } else {
          if (data.previousVersion) {
            logger
              .info`Replaced version ${data.previousVersion} with ${data.version}`;
          } else {
            logger.info`Fetched source: ${data.version}`;
          }
          logger.info`Path: ${data.path}`;
          logger.info`Files: ${data.fileCount}`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonSourceFetchRenderer implements Renderer<SourceFetchEvent> {
  handlers(): EventHandlers<SourceFetchEvent> {
    return {
      fetching: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createSourceFetchRenderer(
  mode: OutputMode,
): Renderer<SourceFetchEvent> {
  switch (mode) {
    case "json":
      return new JsonSourceFetchRenderer();
    case "log":
      return new LogSourceFetchRenderer();
  }
}
