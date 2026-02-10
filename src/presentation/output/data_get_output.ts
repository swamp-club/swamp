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
 * Formats a byte size into a human-readable string.
 */
function formatSize(bytes?: number): string {
  if (bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Renders the data get output in either log or JSON mode.
 */
export function renderDataGet(data: DataGetData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Data: ${data.name} (v${data.version})`);
    console.log(`Model: ${data.modelName} (${data.modelType})`);
    console.log(`Content: ${data.contentType}, ${formatSize(data.size)}`);
    console.log(`Lifetime: ${data.lifetime} | GC: ${data.garbageCollection}`);

    const tagEntries = Object.entries(data.tags);
    if (tagEntries.length > 0) {
      const tagStr = tagEntries.map(([k, v]) => `${k}=${v}`).join(", ");
      console.log(`Tags: ${tagStr}`);
    }

    console.log(
      `Owner: ${data.ownerDefinition.ownerType} (${data.ownerDefinition.ownerRef})`,
    );
    console.log(`Created: ${data.createdAt}`);
    console.log(`Path: ${data.contentPath}`);
  }
}
