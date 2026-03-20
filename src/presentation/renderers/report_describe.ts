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

import type { EventHandlers, ReportDescribeEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

class LogReportDescribeRenderer implements Renderer<ReportDescribeEvent> {
  handlers(): EventHandlers<ReportDescribeEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const d = e.data;
        writeOutput(`Report: ${d.name}`);
        writeOutput(`Description: ${d.description}`);
        writeOutput(`Scope: ${d.scope}`);
        if (d.labels.length > 0) {
          writeOutput(`Labels: ${d.labels.join(", ")}`);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonReportDescribeRenderer implements Renderer<ReportDescribeEvent> {
  handlers(): EventHandlers<ReportDescribeEvent> {
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

export function createReportDescribeRenderer(
  mode: OutputMode,
): Renderer<ReportDescribeEvent> {
  switch (mode) {
    case "json":
      return new JsonReportDescribeRenderer();
    case "log":
      return new LogReportDescribeRenderer();
  }
}
