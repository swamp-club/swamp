import type { OutputMode } from "./output.ts";

/**
 * Data structure for provenance information.
 */
export interface ProvenanceData {
  definitionHash: string;
  modelVersion: number;
  triggeredBy: string;
  workflowId?: string;
  workflowRunId?: string;
  stepName?: string;
}

/**
 * Data structure for a data artifact reference.
 */
export interface DataArtifactRefData {
  dataId: string;
  name: string;
  version: number;
  tags: Record<string, string>;
}

/**
 * Data structure for artifacts information.
 */
export interface ArtifactsData {
  dataArtifacts: DataArtifactRefData[];
}

/**
 * Data structure for error information.
 */
export interface ErrorData {
  message: string;
  stack?: string;
}

/**
 * Data structure for the model output get output.
 */
export interface ModelOutputGetData {
  id: string;
  definitionId: string;
  modelName?: string;
  type: string;
  methodName: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  retryCount: number;
  provenance: ProvenanceData;
  artifacts?: ArtifactsData;
  error?: ErrorData;
}

/**
 * Renders the model output get output in either log or JSON mode.
 */
export function renderModelOutputGet(
  data: ModelOutputGetData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
