import type { OutputMode } from "./output.ts";

/**
 * Artifact information for method output.
 */
export interface ArtifactInfo {
  id: string;
  path: string;
  attributes?: Record<string, unknown>;
}

export interface ModelMethodRunData {
  modelId: string;
  modelName: string;
  type: string;
  methodName: string;
  // Artifact outputs (all optional, depends on what the method produces)
  resource?: ArtifactInfo;
  data?: ArtifactInfo;
  file?: ArtifactInfo;
  logs?: ArtifactInfo[];
}

export function renderModelMethodRun(
  data: ModelMethodRunData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    // Log mode also uses JSON output since model_method_run.ts command
    // already handles log mode output via runLogger.
    console.log(JSON.stringify(data, null, 2));
  }
}
