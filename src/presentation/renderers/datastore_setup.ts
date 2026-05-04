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

import type { DatastoreSetupEvent, EventHandlers } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, yellow } from "@std/fmt/colors";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

class LogDatastoreSetupRenderer implements Renderer<DatastoreSetupEvent> {
  handlers(): EventHandlers<DatastoreSetupEvent> {
    const logger = getSwampLogger(["datastore", "setup"]);
    return {
      validating: () => {},
      migrating: () => {
        logger.info`Migrating data...`;
      },
      hydrating: () => {
        logger.info`Hydrating cache from remote...`;
      },
      completed: (e) => {
        const data = e.data;
        const lines = [
          bold("Datastore Setup Complete"),
          `  Type:     ${data.type}`,
        ];
        if (data.path) {
          lines.push(`  Path:     ${data.path}`);
        }
        lines.push(
          `  Files:    ${data.filesCopied} copied (${
            formatBytes(data.bytesCopied)
          })`,
        );
        // Always surface the hydration count for extension datastores
        // (filesystem datastores have no separate cache to hydrate, so
        // filesPulled is structurally always 0 there and the line is
        // meaningless). Showing 0 for extensions confirms hydration ran
        // and lets the user distinguish "ran and found nothing" from
        // "was skipped entirely".
        if (data.type !== "filesystem") {
          lines.push(`  Hydrated: ${data.filesPulled} pulled`);
        }
        lines.push(`  Dirs:     ${data.directoriesMigrated.join(", ")}`);

        if (data.errors.length > 0) {
          lines.push("");
          lines.push(yellow("Warnings:"));
          for (const err of data.errors) {
            lines.push(`  ${yellow("!")} ${err}`);
          }
        }

        writeOutput(lines.join("\n"));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreSetupRenderer implements Renderer<DatastoreSetupEvent> {
  handlers(): EventHandlers<DatastoreSetupEvent> {
    return {
      validating: () => {},
      migrating: () => {},
      hydrating: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDatastoreSetupRenderer(
  mode: OutputMode,
): Renderer<DatastoreSetupEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreSetupRenderer();
    case "log":
      return new LogDatastoreSetupRenderer();
  }
}
