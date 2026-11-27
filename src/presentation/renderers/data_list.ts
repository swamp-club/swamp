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
  DataListData,
  DataListEvent,
  WorkflowDataListData,
} from "../../libswamp/data/list.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { getTerminalColumns } from "../output/terminal_size.ts";
import { escapeControlCharacters } from "../../domain/control_characters.ts";

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isWorkflowData(
  data: DataListData | WorkflowDataListData,
): data is WorkflowDataListData {
  return "workflowId" in data;
}

class LogDataListRenderer implements Renderer<DataListEvent> {
  constructor(private showNamespace: boolean) {}

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
    const cols = getTerminalColumns();
    const header = this.showNamespace && data.namespace
      ? `Data for ${escapeControlCharacters(data.namespace)}:${
        escapeControlCharacters(data.modelName)
      } (${escapeControlCharacters(data.modelType)})`
      : `Data for ${escapeControlCharacters(data.modelName)} (${
        escapeControlCharacters(data.modelType)
      })`;
    console.log(header);
    console.log();

    for (const group of data.groups) {
      const count = group.items.length;
      console.log(
        `${escapeControlCharacters(group.type)} (${count} ${
          count === 1 ? "item" : "items"
        }):`,
      );
      for (const item of group.items) {
        const size = formatSize(item.size);
        const date = escapeControlCharacters(item.createdAt.slice(0, 10));
        let line = `  ${escapeControlCharacters(item.name)}  v${
          escapeControlCharacters(String(item.version))
        }  ${escapeControlCharacters(item.contentType)}  ${size}  ${date}`;
        if (line.length > cols) {
          line = line.substring(0, cols - 1) + "…";
        }
        console.log(line);
      }
      console.log();
    }
  }

  private renderWorkflow(data: WorkflowDataListData): void {
    const cols = getTerminalColumns();
    console.log(
      `Data for workflow ${escapeControlCharacters(data.workflowName)} (run ${
        escapeControlCharacters(data.runId.slice(0, 8))
      })`,
    );
    console.log();

    for (const group of data.groups) {
      const count = group.items.length;
      console.log(
        `${escapeControlCharacters(group.type)} (${count} ${
          count === 1 ? "item" : "items"
        }):`,
      );
      for (const item of group.items) {
        const size = formatSize(item.size);
        const step = item.jobName !== undefined && item.stepName !== undefined
          ? `${escapeControlCharacters(item.jobName)}.${
            escapeControlCharacters(item.stepName)
          }`
          : "(workflow)";
        let line = `  ${escapeControlCharacters(item.name)}  v${
          escapeControlCharacters(String(item.version))
        }  ${escapeControlCharacters(item.modelName)}  ${step}  ${size}`;
        if (line.length > cols) {
          line = line.substring(0, cols - 1) + "…";
        }
        console.log(line);
      }
      console.log();
    }
  }
}

class JsonDataListRenderer implements Renderer<DataListEvent> {
  constructor(private showNamespace: boolean) {}

  handlers(): EventHandlers<DataListEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (!this.showNamespace && !isWorkflowData(e.data)) {
          const { namespace: _ns, ...rest } = e.data;
          console.log(JSON.stringify(rest, null, 2));
        } else {
          console.log(JSON.stringify(e.data, null, 2));
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDataListRenderer(
  mode: OutputMode,
  showNamespace = false,
): Renderer<DataListEvent> {
  switch (mode) {
    case "json":
      return new JsonDataListRenderer(showNamespace);
    case "log":
      return new LogDataListRenderer(showNamespace);
  }
}
