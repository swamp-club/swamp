import type { OutputMode } from "./output.ts";

/**
 * Version information for data.
 */
export interface DataVersionInfo {
  version: number;
  createdAt: string;
  size?: number;
  checksum?: string;
  isLatest: boolean;
}

/**
 * Data structure for the data versions output.
 */
export interface DataVersionsData {
  dataName: string;
  modelId: string;
  modelName: string;
  modelType: string;
  versions: DataVersionInfo[];
  total: number;
}

/**
 * Renders the data versions output in either log or JSON mode.
 */
export function renderDataVersions(
  data: DataVersionsData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
