import type { OutputMode } from "./output.ts";

/**
 * Represents a single data search result item.
 */
export interface DataSearchItem {
  id: string;
  name: string;
  version: number;
  contentType: string;
  type: string;
  lifetime: string;
  ownerType: string;
  ownerRef: string;
  modelId: string;
  modelName: string;
  modelType: string;
  streaming: boolean;
  size?: number;
  createdAt: string;
  workflowTag?: string;
  stepTag?: string;
}

/**
 * Data structure for data search results.
 */
export interface DataSearchData {
  query: string;
  filters: Record<string, string>;
  results: DataSearchItem[];
  total: number;
  limited: boolean;
}

/**
 * Renders data search results in either log or JSON mode.
 */
export function renderDataSearch(data: DataSearchData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
