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
