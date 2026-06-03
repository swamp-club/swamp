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

import type { ExtensionUpdateStatus } from "../../domain/extensions/extension_update_service.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

/**
 * Result payload for the outdated check. Filtered to non-up_to_date
 * statuses; the strict exit-code-1-only-on-update_available semantic
 * is enforced by the caller, not the renderer.
 */
export interface ExtensionOutdatedResult {
  extensions: ExtensionUpdateStatus[];
  hasUpdateAvailable: boolean;
  hasDeprecated: boolean;
}

export type ExtensionOutdatedEvent = {
  kind: "completed";
  data: ExtensionOutdatedResult;
};

class LogExtensionOutdatedRenderer implements Renderer<ExtensionOutdatedEvent> {
  handlers() {
    const logger = getSwampLogger(["extension", "outdated"]);
    return {
      completed: (e: ExtensionOutdatedEvent) => {
        const exts = e.data.extensions;
        if (exts.length === 0) {
          logger.info("All extensions are up to date.");
          return;
        }

        const maxName = Math.max(...exts.map((x) => x.name.length));

        // not_found and failed render as warnings to match
        // `extension update --check` parity. They do NOT fail the exit
        // code (only update_available does) — see the command-level
        // exit-code logic and design/extension.md for the rationale.
        for (const ext of exts) {
          const paddedName = ext.name.padEnd(maxName);
          switch (ext.status) {
            case "update_available":
              logger.info("{line}", {
                line:
                  `${paddedName}  v${ext.installedVersion} -> v${ext.latestVersion}  (update available)`,
              });
              break;
            case "not_found":
              logger.warn("{line}", {
                line:
                  `${paddedName}  v${ext.installedVersion}  (not found in registry)`,
              });
              break;
            case "failed":
              logger.warn("{line}", {
                line:
                  `${paddedName}  v${ext.installedVersion}  (check failed: ${ext.error})`,
              });
              break;
            case "deprecated": {
              let line = `${paddedName}  v${ext.installedVersion}  (deprecated`;
              if (ext.supersededBy) {
                line += ` — use ${ext.supersededBy} instead`;
              }
              line += ")";
              logger.warn("{line}", { line });
              break;
            }
              // up_to_date and updated are filtered before reaching the
              // renderer; updated never appears in checkOnly mode.
          }
        }

        const available = exts.filter(
          (x) => x.status === "update_available",
        ).length;
        if (available > 0) {
          logger.info(
            "\n{count} update(s) available. Run 'swamp extension update' to update.",
            { count: available },
          );
        }
      },
    };
  }
}

class JsonExtensionOutdatedRenderer
  implements Renderer<ExtensionOutdatedEvent> {
  handlers() {
    return {
      completed: (e: ExtensionOutdatedEvent) => {
        console.log(
          JSON.stringify(
            {
              extensions: e.data.extensions,
              hasUpdateAvailable: e.data.hasUpdateAvailable,
              hasDeprecated: e.data.hasDeprecated,
            },
            null,
            2,
          ),
        );
      },
    };
  }
}

export function createExtensionOutdatedRenderer(
  mode: OutputMode,
): Renderer<ExtensionOutdatedEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionOutdatedRenderer();
    case "log":
      return new LogExtensionOutdatedRenderer();
  }
}
