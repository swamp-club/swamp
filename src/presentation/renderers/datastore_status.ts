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

import { bold, green, red } from "@std/fmt/colors";
import type {
  DatastoreStatusEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

class LogDatastoreStatusRenderer implements Renderer<DatastoreStatusEvent> {
  handlers(): EventHandlers<DatastoreStatusEvent> {
    return {
      completed: (e) => {
        const data = e.data;
        const healthIcon = data.healthy ? green("\u25CF") : red("\u25CF");
        const healthText = data.healthy ? green("healthy") : red("unhealthy");

        const lines = [
          bold("Datastore Status"),
          `  Type:    ${data.type}`,
        ];
        if (data.path) {
          lines.push(`  Path:    ${data.path}`);
        }
        lines.push(
          `  Health:  ${healthIcon} ${healthText} (${
            Math.round(data.latencyMs)
          }ms)`,
        );
        if (!data.healthy) {
          lines.push(`  Error:   ${data.message}`);
        }
        lines.push(`  Dirs:    ${data.directories.join(", ")}`);
        if (data.exclude && data.exclude.length > 0) {
          lines.push(`  Exclude: ${data.exclude.join(", ")}`);
        }

        writeOutput(lines.join("\n"));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreStatusRenderer implements Renderer<DatastoreStatusEvent> {
  handlers(): EventHandlers<DatastoreStatusEvent> {
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

export function createDatastoreStatusRenderer(
  mode: OutputMode,
): Renderer<DatastoreStatusEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreStatusRenderer();
    case "log":
      return new LogDatastoreStatusRenderer();
  }
}
