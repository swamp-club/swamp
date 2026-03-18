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

import type {
  DataGetData,
  DataGetEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

/**
 * Formats a byte size into a human-readable string.
 */
function formatSize(bytes?: number): string {
  if (bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

class LogDataGetRenderer implements Renderer<DataGetEvent> {
  handlers(): EventHandlers<DataGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const data = e.data;
        writeOutput(`Data: ${data.name} (v${data.version})`);
        writeOutput(`Model: ${data.modelName} (${data.modelType})`);
        writeOutput(
          `Content: ${data.contentType}, ${formatSize(data.size)}`,
        );
        writeOutput(
          `Lifetime: ${data.lifetime} | GC: ${data.garbageCollection}`,
        );

        const tagEntries = Object.entries(data.tags);
        if (tagEntries.length > 0) {
          const tagStr = tagEntries.map(([k, v]) => `${k}=${v}`).join(", ");
          writeOutput(`Tags: ${tagStr}`);
        }

        writeOutput(
          `Owner: ${data.ownerDefinition.ownerType} (${data.ownerDefinition.ownerRef})`,
        );
        writeOutput(`Created: ${data.createdAt}`);
        writeOutput(`Path: ${data.contentPath}`);

        if (data.content !== undefined) {
          writeOutput("");
          if (data.contentType === "application/json") {
            try {
              const parsed = JSON.parse(data.content);
              writeOutput(JSON.stringify(parsed, null, 2));
            } catch {
              writeOutput(data.content);
            }
          } else {
            writeOutput(data.content);
          }
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDataGetRenderer implements Renderer<DataGetEvent> {
  handlers(): EventHandlers<DataGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const jsonOutput: Record<string, unknown> = { ...e.data };
        // Parse JSON content inline for structured output
        if (
          e.data.content && e.data.contentType === "application/json"
        ) {
          try {
            jsonOutput.content = JSON.parse(e.data.content);
          } catch {
            // Leave as string if not valid JSON
          }
        }
        console.log(JSON.stringify(jsonOutput, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDataGetRenderer(
  mode: OutputMode,
): Renderer<DataGetEvent> {
  switch (mode) {
    case "json":
      return new JsonDataGetRenderer();
    case "log":
      return new LogDataGetRenderer();
  }
}

/** Standalone render function for use by un-migrated search commands. */
export function renderDataGet(data: DataGetData, mode: OutputMode): void {
  const renderer = createDataGetRenderer(mode);
  const handlers = renderer.handlers();
  handlers.completed({ kind: "completed", data });
}
