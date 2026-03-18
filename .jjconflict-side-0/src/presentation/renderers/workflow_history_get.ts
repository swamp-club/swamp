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
  WorkflowHistoryGetEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderWorkflowRun } from "../output/workflow_run_output.ts";

class LogWorkflowHistoryGetRenderer
  implements Renderer<WorkflowHistoryGetEvent> {
  handlers(): EventHandlers<WorkflowHistoryGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        renderWorkflowRun(e.data, "log");
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonWorkflowHistoryGetRenderer
  implements Renderer<WorkflowHistoryGetEvent> {
  handlers(): EventHandlers<WorkflowHistoryGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        renderWorkflowRun(e.data, "json");
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createWorkflowHistoryGetRenderer(
  mode: OutputMode,
): Renderer<WorkflowHistoryGetEvent> {
  switch (mode) {
    case "json":
      return new JsonWorkflowHistoryGetRenderer();
    case "log":
      return new LogWorkflowHistoryGetRenderer();
  }
}
