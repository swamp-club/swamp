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

import { bold, dim, green, yellow } from "@std/fmt/colors";
import type {
  EventHandlers,
  NamespaceMigrateEvent,
  NamespaceMigratePreviewData,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

class LogNamespaceMigrateRenderer implements Renderer<NamespaceMigrateEvent> {
  handlers(): EventHandlers<NamespaceMigrateEvent> {
    return {
      preview: (e) => {
        const direction = e.data.reverse ? "Reverse migration" : "Migration";
        const lines = [
          bold(`${direction} preview (namespace: "${e.data.namespace}")`),
          "",
        ];

        for (const dir of e.data.directories) {
          lines.push(
            `  ${dir.subdir}`,
            `    ${dim(dir.source)}`,
            `    → ${dir.destination}`,
            `    ${
              dim(`${dir.fileCount} file(s), ${formatBytes(dir.totalBytes)}`)
            }`,
          );
        }

        lines.push(
          "",
          `Total: ${e.data.totalFiles} file(s), ${
            formatBytes(e.data.totalBytes)
          }`,
        );

        if (!e.data.confirm) {
          lines.push("", yellow("Add --confirm to execute this migration."));
        }

        writeOutput(lines.join("\n"));
      },
      progress: (e) => {
        writeOutput(green(`  ✓ ${e.data.subdir}`));
      },
      completed: (e) => {
        if (e.data.migratedDirectories.length === 0) return;

        const direction = e.data.reverse ? "Reverse migration" : "Migration";
        const lines = [
          "",
          bold(
            `${direction} complete: ${e.data.migratedDirectories.length} directory(s) moved`,
          ),
          `  Total: ${e.data.totalFiles} file(s), ${
            formatBytes(e.data.totalBytes)
          }`,
        ];

        if (e.data.isExtensionDatastore) {
          lines.push(
            "",
            yellow(
              "This is an extension datastore. Run 'swamp datastore sync --push' to sync the new layout to the remote.",
            ),
          );
        }

        writeOutput(lines.join("\n"));
      },
      error: (e) => {
        if (e.succeededDirectories.length > 0) {
          const lines = [
            "",
            yellow(
              `Partially migrated: ${e.succeededDirectories.length} directory(s) moved before failure.`,
            ),
            `  Succeeded: ${e.succeededDirectories.join(", ")}`,
          ];
          if (e.failedDirectory) {
            lines.push(`  Failed: ${e.failedDirectory}`);
          }
          writeOutput(lines.join("\n"));
        }
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonNamespaceMigrateRenderer implements Renderer<NamespaceMigrateEvent> {
  #previewData: NamespaceMigratePreviewData | null = null;

  handlers(): EventHandlers<NamespaceMigrateEvent> {
    return {
      preview: (e) => {
        this.#previewData = e.data;
      },
      progress: () => {},
      completed: (e) => {
        if (e.data.migratedDirectories.length > 0) {
          writeOutput(JSON.stringify(e.data, null, 2));
        } else {
          writeOutput(JSON.stringify(this.#previewData, null, 2));
        }
      },
      error: (e) => {
        if (e.succeededDirectories.length > 0 || e.failedDirectory) {
          writeOutput(JSON.stringify(
            {
              error: e.error.message,
              succeededDirectories: e.succeededDirectories,
              failedDirectory: e.failedDirectory ?? null,
            },
            null,
            2,
          ));
        }
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createNamespaceMigrateRenderer(
  mode: OutputMode,
): Renderer<NamespaceMigrateEvent> {
  switch (mode) {
    case "json":
      return new JsonNamespaceMigrateRenderer();
    case "log":
      return new LogNamespaceMigrateRenderer();
  }
}
