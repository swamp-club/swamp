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

import type {
  EventHandlers,
  WorkflowHistoryLogsEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";

class LogWorkflowHistoryLogsRenderer
  implements Renderer<WorkflowHistoryLogsEvent> {
  handlers(): EventHandlers<WorkflowHistoryLogsEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        switch (e.data.type) {
          case "log":
            for (const line of e.data.log.lines) {
              console.log(line);
            }
            break;
          case "no_log_file":
            console.log(
              `No log file recorded for run ${
                e.data.info.runId.slice(0, 8)
              }. ` +
                `This run predates log file tracking.`,
            );
            break;
          case "empty_log":
            console.log(
              `Log file not found or empty: ${e.data.info.path}`,
            );
            break;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonWorkflowHistoryLogsRenderer
  implements Renderer<WorkflowHistoryLogsEvent> {
  handlers(): EventHandlers<WorkflowHistoryLogsEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        switch (e.data.type) {
          case "log":
            console.log(JSON.stringify(
              {
                path: e.data.log.path,
                lines: e.data.log.lines,
                lineCount: e.data.log.lines.length,
              },
              null,
              2,
            ));
            break;
          case "no_log_file":
            console.log(JSON.stringify(
              {
                runId: e.data.info.runId,
                workflowName: e.data.info.workflowName,
                error: "No log file recorded for this run (pre-logFile run)",
              },
              null,
              2,
            ));
            break;
          case "empty_log":
            console.log(JSON.stringify(
              {
                runId: e.data.info.runId,
                workflowName: e.data.info.workflowName,
                path: e.data.info.path,
                lines: [],
                lineCount: 0,
              },
              null,
              2,
            ));
            break;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createWorkflowHistoryLogsRenderer(
  mode: OutputMode,
): Renderer<WorkflowHistoryLogsEvent> {
  switch (mode) {
    case "json":
      return new JsonWorkflowHistoryLogsRenderer();
    case "log":
      return new LogWorkflowHistoryLogsRenderer();
  }
}
