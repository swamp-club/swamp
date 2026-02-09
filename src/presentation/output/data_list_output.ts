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
 * Renders the data list output in either log or JSON mode.
 */
export function renderDataList(
  data: DataListData | WorkflowDataListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
