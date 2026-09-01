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

import type { EventHandlers, UpdateCheckEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import {
  getSwampLogger,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

export interface UpdateCheckRenderer extends Renderer<UpdateCheckEvent> {
  readonly updated: boolean;
}

class LogUpdateCheckRenderer implements UpdateCheckRenderer {
  updated = false;

  handlers(): EventHandlers<UpdateCheckEvent> {
    const logger = getSwampLogger(["update"]);
    return {
      checking: () => {},
      completed: (e) => {
        const data = e.data;
        switch (data.status) {
          case "up_to_date":
            writeOutput(`swamp is up to date (${data.currentVersion})`);
            break;
          case "update_available":
            writeOutput(
              `Update available: ${data.currentVersion} \u2192 ${data.latestVersion}`,
            );
            writeOutput("Run `swamp update` to install");
            break;
          case "updated":
            this.updated = true;
            writeOutput("swamp updated successfully!");
            writeOutput(
              `${data.previousVersion} \u2192 ${data.newVersion}`,
            );
            writeOutput("SHA-256 integrity check passed");
            writeOutput("The swamp binary has been updated globally.");
            writeOutput(
              "Run `swamp repo upgrade` in your repositories to update settings and instructions.",
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

class JsonUpdateCheckRenderer implements UpdateCheckRenderer {
  updated = false;

  handlers(): EventHandlers<UpdateCheckEvent> {
    return {
      checking: () => {},
      completed: (e) => {
        if (e.data.status === "updated") {
          this.updated = true;
        }
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
): UpdateCheckRenderer {
  switch (mode) {
    case "json":
      return new JsonUpdateCheckRenderer();
    case "log":
      return new LogUpdateCheckRenderer();
  }
}
