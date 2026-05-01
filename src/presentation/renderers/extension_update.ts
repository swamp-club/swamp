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
  EventHandlers,
  ExtensionUpdateEvent,
  ExtensionUpdateResult,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogExtensionUpdateRenderer implements Renderer<ExtensionUpdateEvent> {
  handlers(): EventHandlers<ExtensionUpdateEvent> {
    const logger = getSwampLogger(["extension", "update"]);
    return {
      no_extensions: () => {
        logger.info("No upstream extensions installed.");
        logger.info(
          "Use 'swamp extension pull @namespace/name' to install one.",
        );
      },
      extension_not_installed: (e) => {
        logger.error`Extension ${e.name} is not installed.`;
      },
      checking: () => {},
      updating: (e) => {
        logger.info`Updating ${e.name}: v${e.from} -> v${e.to}`;
      },
      "orphans-pruned": (e) => {
        logger.info(
          "Removed {count} file(s) no longer in {name} (v{from} -> v{to}):",
          {
            count: e.paths.length,
            name: e.name,
            from: e.from,
            to: e.to,
          },
        );
        for (const p of e.paths) {
          logger.info("  {path}", { path: p });
        }
      },
      completed: (e) => {
        if (e.mode === "check") {
          renderCheckLog(e.data, logger);
        } else {
          renderUpdateLog(e.data, logger);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionUpdateRenderer implements Renderer<ExtensionUpdateEvent> {
  handlers(): EventHandlers<ExtensionUpdateEvent> {
    return {
      no_extensions: () => {
        console.log(
          JSON.stringify({ extensions: [], summary: { total: 0 } }, null, 2),
        );
      },
      extension_not_installed: (e) => {
        console.log(
          JSON.stringify(
            { error: `Extension ${e.name} is not installed.` },
            null,
            2,
          ),
        );
      },
      checking: () => {},
      updating: (e) => {
        console.log(
          JSON.stringify(
            { status: "updating", name: e.name, from: e.from, to: e.to },
            null,
            2,
          ),
        );
      },
      "orphans-pruned": (e) => {
        console.log(
          JSON.stringify(
            {
              status: "orphans_pruned",
              name: e.name,
              from: e.from,
              to: e.to,
              paths: e.paths,
            },
            null,
            2,
          ),
        );
      },
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

import type { Logger } from "@logtape/logtape";

function renderCheckLog(result: ExtensionUpdateResult, logger: Logger): void {
  if (result.extensions.length === 0) {
    logger.info("No upstream extensions installed.");
    return;
  }

  const maxName = Math.max(...result.extensions.map((e) => e.name.length));

  for (const ext of result.extensions) {
    const paddedName = ext.name.padEnd(maxName);
    switch (ext.status) {
      case "up_to_date":
        logger.info("{line}", {
          line: `${paddedName}  v${ext.installedVersion}  (up to date)`,
        });
        break;
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
            `${paddedName}  v${ext.installedVersion}  (update failed: ${ext.error})`,
        });
        break;
    }
  }

  const available = result.extensions.filter(
    (e) => e.status === "update_available",
  ).length;
  if (available > 0) {
    logger.info(
      "\n{count} update(s) available. Run 'swamp extension update' to update.",
      { count: available },
    );
  } else {
    logger.info("\nAll extensions are up to date.");
  }
}

function renderUpdateLog(result: ExtensionUpdateResult, logger: Logger): void {
  for (const ext of result.extensions) {
    switch (ext.status) {
      case "updated":
        logger.info("{line}", {
          line:
            `Updated ${ext.name}: v${ext.previousVersion} -> v${ext.newVersion}`,
        });
        break;
      case "up_to_date":
        logger.info("{line}", {
          line: `${ext.name}: already up to date (v${ext.installedVersion})`,
        });
        break;
      case "not_found":
        logger.warn("{line}", {
          line: `${ext.name}: ${ext.error}`,
        });
        break;
      case "failed":
        logger.warn("{line}", {
          line: `${ext.name}: ${ext.error}`,
        });
        break;
    }
  }

  const { summary } = result;
  logger.info("\n{line}", {
    line:
      `${summary.total} extension(s): ${summary.updated} updated, ${summary.upToDate} up to date, ${summary.failed} failed`,
  });
}

export function createExtensionUpdateRenderer(
  mode: OutputMode,
): Renderer<ExtensionUpdateEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionUpdateRenderer();
    case "log":
      return new LogExtensionUpdateRenderer();
  }
}
