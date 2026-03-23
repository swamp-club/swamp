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

import type { EventHandlers, UpdateCheckEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogUpdateCheckRenderer implements Renderer<UpdateCheckEvent> {
  handlers(): EventHandlers<UpdateCheckEvent> {
    const logger = getSwampLogger(["update"]);
    return {
      checking: () => {},
      completed: (e) => {
        const data = e.data;
        switch (data.status) {
          case "up_to_date":
            logger.info`swamp is up to date (${data.currentVersion})`;
            break;
          case "update_available":
            logger
              .info`Update available: ${data.currentVersion} \u2192 ${data.latestVersion}`;
            logger.info("Run `swamp update` to install");
            break;
          case "updated":
            logger.info("swamp updated successfully!");
            logger.info`${data.previousVersion} \u2192 ${data.newVersion}`;
            logger.info("SHA-256 integrity check passed");
            logger.info("The swamp binary has been updated globally.");
            logger.info(
              "Run `swamp repo upgrade` in your repositories to update skills and settings.",
            );
            break;
        }
        if (data.warning) {
          logger.warn`${data.warning}`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonUpdateCheckRenderer implements Renderer<UpdateCheckEvent> {
  handlers(): EventHandlers<UpdateCheckEvent> {
    return {
      checking: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createUpdateCheckRenderer(
  mode: OutputMode,
): Renderer<UpdateCheckEvent> {
  switch (mode) {
    case "json":
      return new JsonUpdateCheckRenderer();
    case "log":
      return new LogUpdateCheckRenderer();
  }
}
