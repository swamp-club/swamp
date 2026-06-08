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

import type { CreekDescribeEvent, EventHandlers } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

class LogCreekDescribeRenderer implements Renderer<CreekDescribeEvent> {
  handlers(): EventHandlers<CreekDescribeEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const d = e.data;
        writeOutput(`Creek: ${d.type}`);
        writeOutput(`Version: ${d.version}`);
        if (d.description) writeOutput(`Description: ${d.description}`);
        writeOutput("");
        writeOutput("Methods:");
        for (const m of d.methods) {
          writeOutput(`  - ${m.name}: ${m.description}`);
          writeOutput(`    arguments: ${JSON.stringify(m.arguments)}`);
          if (m.returns) {
            writeOutput(`    returns: ${JSON.stringify(m.returns)}`);
          }
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonCreekDescribeRenderer implements Renderer<CreekDescribeEvent> {
  handlers(): EventHandlers<CreekDescribeEvent> {
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

export function createCreekDescribeRenderer(
  mode: OutputMode,
): Renderer<CreekDescribeEvent> {
  switch (mode) {
    case "json":
      return new JsonCreekDescribeRenderer();
    case "log":
      return new LogCreekDescribeRenderer();
  }
}
