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
  DataListData,
  DataListEvent,
  EventHandlers,
  WorkflowDataListData,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";

/** Formats a byte size into a human-readable string. */
function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Type guard to check if data is WorkflowDataListData. */
function isWorkflowData(
  data: DataListData | WorkflowDataListData,
): data is WorkflowDataListData {
  return "workflowId" in data;
}

class LogDataListRenderer implements Renderer<DataListEvent> {
  handlers(): EventHandlers<DataListEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (isWorkflowData(e.data)) {
          this.renderWorkflow(e.data);
        } else {
          this.renderModel(e.data);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  private renderModel(data: DataListData): void {
    console.log(`Data for ${data.modelName} (${data.modelType})`);
    console.log();

    for (const group of data.groups) {
      const count = group.items.length;
      console.log(
        `${group.type} (${count} ${count === 1 ? "item" : "items"}):`,
      );
      for (const item of group.items) {
        const size = formatSize(item.size);
        const date = item.createdAt.slice(0, 10);
        console.log(
          `  ${item.name}  v${item.version}  ${item.contentType}  ${size}  ${date}`,
        );
      }
      console.log();
    }
  }

  private renderWorkflow(data: WorkflowDataListData): void {
    console.log(
      `Data for workflow ${data.workflowName} (run ${data.runId.slice(0, 8)})`,
    );
    console.log();

    for (const group of data.groups) {
      const count = group.items.length;
      console.log(
        `${group.type} (${count} ${count === 1 ? "item" : "items"}):`,
      );
      for (const item of group.items) {
        const size = formatSize(item.size);
        const step = item.jobName !== undefined && item.stepName !== undefined
          ? `${item.jobName}.${item.stepName}`
          : "(workflow)";
        console.log(
          `  ${item.name}  v${item.version}  ${item.modelName}  ${step}  ${size}`,
        );
      }
      console.log();
    }
  }
}

class JsonDataListRenderer implements Renderer<DataListEvent> {
  handlers(): EventHandlers<DataListEvent> {
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

export function createDataListRenderer(
  mode: OutputMode,
): Renderer<DataListEvent> {
  switch (mode) {
    case "json":
      return new JsonDataListRenderer();
    case "log":
      return new LogDataListRenderer();
  }
}
