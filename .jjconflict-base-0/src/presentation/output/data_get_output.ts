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
    definitionHash?: string;
    ownerType: string;
    ownerRef: string;
    workflowId?: string;
    workflowRunId?: string;
  };
  createdAt: string;
  size?: number;
  checksum?: string;
  contentPath: string;
  content?: string;
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
    const jsonOutput: Record<string, unknown> = { ...data };
    // Parse JSON content inline for structured output
    if (data.content && data.contentType === "application/json") {
      try {
        jsonOutput.content = JSON.parse(data.content);
      } catch {
        // Leave as string if not valid JSON
      }
    }
    console.log(JSON.stringify(jsonOutput, null, 2));
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

    if (data.content !== undefined) {
      console.log();
      if (data.contentType === "application/json") {
        try {
          const parsed = JSON.parse(data.content);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(data.content);
        }
      } else {
        console.log(data.content);
      }
    }
  }
}
