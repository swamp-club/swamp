// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import { dim } from "@std/fmt/colors";
import type {
  DataGetData,
  DataGetEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import {
  getSwampLogger,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";

/**
 * Formats a byte size into a human-readable string.
 */
function formatSize(bytes?: number): string {
  if (bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Options for rendering a data get read. */
export interface DataGetRenderOptions {
  /**
   * Target arguments (` --server …` / ` --repo-dir …`) appended to every
   * printed query, so a pasted query reaches the same server or repository
   * as the read; see `formatCommandTarget`.
   */
  commandTarget?: string;
}

/**
 * Appends `commandTarget` to every query the read names: its replacement
 * query, each alternative's, and where they appear inside the warnings.
 */
export function withCommandTarget(
  data: DataGetData,
  commandTarget: string | undefined,
): DataGetData {
  if (!commandTarget) return data;
  const queries = [
    data.replacementQuery,
    ...(data.alternatives ?? []).map((alt) => alt.replacementQuery),
  ].filter((query): query is string => query !== undefined);
  if (queries.length === 0) return data;
  // Longest first, so a query that prefixes another never matches inside it.
  const pattern = new RegExp(
    [...new Set(queries)]
      .sort((a, b) => b.length - a.length)
      .map((query) => query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );
  const retarget = (text: string) =>
    text.replace(pattern, (query) => `${query}${commandTarget}`);
  return {
    ...data,
    replacementQuery: data.replacementQuery &&
      retarget(data.replacementQuery),
    warnings: data.warnings?.map(retarget),
    alternatives: data.alternatives?.map((alt) => ({
      ...alt,
      replacementQuery: alt.replacementQuery && retarget(alt.replacementQuery),
    })),
  };
}

class LogDataGetRenderer implements Renderer<DataGetEvent> {
  constructor(private readonly options: DataGetRenderOptions = {}) {}

  handlers(): EventHandlers<DataGetEvent> {
    const logger = getSwampLogger(["data", "get"]);
    return {
      resolving: () => {},
      completed: (e) => {
        const data = withCommandTarget(e.data, this.options.commandTarget);
        for (const warning of data.warnings ?? []) {
          // Braces escaped so a name containing {…} is printed, not read as
          // a LogTape placeholder; a tagged template would quote the text.
          logger.warn(warning.replaceAll("{", "{{").replaceAll("}", "}}"));
        }
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
          if (data.contentEncoding === "base64") {
            const size = formatSize(data.size);
            writeOutput(
              dim(
                `(binary data, ${size} — use --json to get it base64-encoded)`,
              ),
            );
          } else if (data.contentType === "application/json") {
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
  constructor(private readonly options: DataGetRenderOptions = {}) {}

  handlers(): EventHandlers<DataGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const data = withCommandTarget(e.data, this.options.commandTarget);
        const jsonOutput: Record<string, unknown> = { ...data };
        // Parse JSON content inline for structured output
        if (
          data.content && data.contentType === "application/json" &&
          data.contentEncoding !== "base64"
        ) {
          try {
            jsonOutput.content = JSON.parse(data.content);
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
  options: DataGetRenderOptions = {},
): Renderer<DataGetEvent> {
  switch (mode) {
    case "json":
      return new JsonDataGetRenderer(options);
    case "log":
      return new LogDataGetRenderer(options);
  }
}

/** Standalone render function for use by un-migrated search commands. */
export function renderDataGet(
  data: DataGetData,
  mode: OutputMode,
  options: DataGetRenderOptions = {},
): void {
  const renderer = createDataGetRenderer(mode, options);
  const handlers = renderer.handlers();
  handlers.completed({ kind: "completed", data });
}
