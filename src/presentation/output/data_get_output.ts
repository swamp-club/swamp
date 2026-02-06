import type { OutputMode } from "./output.ts";

/**
 * Data structure for the data get output.
 */
export interface DataGetData {
  id: string;
  name: string;
  modelId: string;
  modelName: string;
  modelType: string;
  version: number;
  contentType: string;
  lifetime: string;
  garbageCollection: string | number;
  streaming: boolean;
  tags: Record<string, string>;
  ownerDefinition: {
    definitionHash: string;
    ownerType: string;
    ownerRef: string;
    workflowId?: string;
    workflowRunId?: string;
  };
  createdAt: string;
  size?: number;
  checksum?: string;
  contentPath: string;
}

/**
 * Renders the data get output in either log or JSON mode.
 */
export function renderDataGet(data: DataGetData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
