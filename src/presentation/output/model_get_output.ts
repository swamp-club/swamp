import type { OutputMode } from "./output.ts";

/**
 * Data structure for resource information.
 */
export interface ResourceData {
  id: string;
  createdAt: string;
  attributes: Record<string, unknown>;
}

/**
 * Data structure for the model get output.
 */
export interface ModelGetData {
  id: string;
  name: string;
  type: string;
  version: number;
  tags: Record<string, string>;
  attributes: Record<string, unknown>;
  resource?: ResourceData;
}

/**
 * Renders the model get output in either log or JSON mode.
 */
export function renderModelGet(data: ModelGetData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
