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

import type { EventHandlers, SourceListEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, dim, green, red, yellow } from "@std/fmt/colors";

class LogSourceListRenderer implements Renderer<SourceListEvent> {
  handlers(): EventHandlers<SourceListEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (e.data.sources.length === 0) {
          writeOutput("No extension sources configured.");
          writeOutput(
            dim(
              'Use "swamp extension source add <path>" to add one.',
            ),
          );
          return;
        }

        writeOutput(bold(`Extension sources (${e.data.sources.length}):`));
        writeOutput("");

        for (const source of e.data.sources) {
          const statusIcon = source.status === "valid"
            ? green("✓")
            : source.status === "path_not_found"
            ? red("✗")
            : yellow("⚠");

          writeOutput(`  ${statusIcon} ${source.path}`);

          if (source.only) {
            writeOutput(dim(`    only: ${source.only.join(", ")}`));
          }

          if (source.status === "path_not_found") {
            writeOutput(red("    path not found"));
            writeOutput(
              dim(
                `    Run 'swamp extension source rm ${source.path}' or fix the path.`,
              ),
            );
          } else if (source.status === "no_extensions") {
            writeOutput(yellow("    no extensions found"));
            writeOutput(
              dim(
                `    Add extension files to the path, or run 'swamp extension source rm ${source.path}'.`,
              ),
            );
          } else {
            if (source.resolvedKinds && source.resolvedKinds.length > 0) {
              writeOutput(
                dim(`    kinds: ${source.resolvedKinds.join(", ")}`),
              );
            }
            if (source.expandedPaths.length > 1) {
              writeOutput(
                dim(`    ${source.expandedPaths.length} extension roots`),
              );
            }
          }
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonSourceListRenderer implements Renderer<SourceListEvent> {
  handlers(): EventHandlers<SourceListEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createSourceListRenderer(
  mode: OutputMode,
): Renderer<SourceListEvent> {
  switch (mode) {
    case "json":
      return new JsonSourceListRenderer();
    case "log":
      return new LogSourceListRenderer();
  }
}
