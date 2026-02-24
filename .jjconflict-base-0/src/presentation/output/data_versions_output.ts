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
