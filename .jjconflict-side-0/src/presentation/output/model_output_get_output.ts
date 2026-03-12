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
 * Data structure for provenance information.
 */
export interface ProvenanceData {
  definitionHash: string;
  modelVersion: string;
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
