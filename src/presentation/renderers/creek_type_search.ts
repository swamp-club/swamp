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

import type {
  CreekTypeSearchEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

class LogCreekTypeSearchRenderer implements Renderer<CreekTypeSearchEvent> {
  handlers(): EventHandlers<CreekTypeSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const { results } = e.data;
        if (results.length === 0) {
          writeOutput("No creeks registered.");
          return;
        }
        for (const r of results) {
          const methods = `${r.methodCount} method${
            r.methodCount === 1 ? "" : "s"
          }`;
          const desc = r.description ? ` — ${r.description}` : "";
          writeOutput(`${r.type} (v${r.version}, ${methods})${desc}`);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonCreekTypeSearchRenderer implements Renderer<CreekTypeSearchEvent> {
  handlers(): EventHandlers<CreekTypeSearchEvent> {
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

export function createCreekTypeSearchRenderer(
  mode: OutputMode,
): Renderer<CreekTypeSearchEvent> {
  switch (mode) {
    case "json":
      return new JsonCreekTypeSearchRenderer();
    case "log":
      return new LogCreekTypeSearchRenderer();
  }
}
