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

import type { OutputMode } from "./output.ts";

/**
 * Data item in the list.
 */
export interface DataListItem {
  id: string;
  name: string;
  version: number;
  contentType: string;
  type: string; // The type tag value
  streaming: boolean;
  size?: number;
  createdAt: string;
}

/**
 * Data grouped by tag type.
 */
export interface DataGroupedByType {
  type: string;
  items: DataListItem[];
}

/**
 * Data structure for the data list output.
 */
export interface DataListData {
  modelId: string;
  modelName: string;
  modelType: string;
  groups: DataGroupedByType[];
  total: number;
}

/**
 * Data item with workflow context.
 */
export interface WorkflowDataListItem extends DataListItem {
  modelId: string;
  modelName: string;
  modelType: string;
  jobName: string;
  stepName: string;
}

/**
 * Data structure for workflow-scoped data list output.
 */
export interface WorkflowDataListData {
  workflowId: string;
  workflowName: string;
  runId: string;
  runStatus: string;
  groups: Array<{ type: string; items: WorkflowDataListItem[] }>;
  total: number;
}

/**
 * Formats a byte size into a human-readable string.
 */
function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Type guard to check if data is WorkflowDataListData.
 */
function isWorkflowData(
  data: DataListData | WorkflowDataListData,
): data is WorkflowDataListData {
  return "workflowId" in data;
}

/**
 * Renders the data list output in either log or JSON mode.
 */
export function renderDataList(
  data: DataListData | WorkflowDataListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else if (isWorkflowData(data)) {
    renderWorkflowDataListLog(data);
  } else {
    renderModelDataListLog(data);
  }
}

/**
 * Renders model-scoped data list in human-readable log format.
 */
function renderModelDataListLog(data: DataListData): void {
  console.log(`Data for ${data.modelName} (${data.modelType})`);
  console.log();

  for (const group of data.groups) {
    const count = group.items.length;
    console.log(`${group.type} (${count} ${count === 1 ? "item" : "items"}):`);
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

/**
 * Renders workflow-scoped data list in human-readable log format.
 */
function renderWorkflowDataListLog(data: WorkflowDataListData): void {
  console.log(
    `Data for workflow ${data.workflowName} (run ${data.runId.slice(0, 8)})`,
  );
  console.log();

  for (const group of data.groups) {
    const count = group.items.length;
    console.log(`${group.type} (${count} ${count === 1 ? "item" : "items"}):`);
    for (const item of group.items) {
      const size = formatSize(item.size);
      const step = `${item.jobName}.${item.stepName}`;
      console.log(
        `  ${item.name}  v${item.version}  ${item.modelName}  ${step}  ${size}`,
      );
    }
    console.log();
  }
}
