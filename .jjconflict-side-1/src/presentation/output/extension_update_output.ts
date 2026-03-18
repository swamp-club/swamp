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
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { ExtensionUpdateResult } from "../../domain/extensions/extension_update_service.ts";

const logger = getSwampLogger(["extension", "update"]);

/**
 * Renders the result of `--check` mode (what's outdated, without pulling).
 */
export function renderExtensionUpdateCheck(
  result: ExtensionUpdateResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

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

/**
 * Renders the final result after performing updates.
 */
export function renderExtensionUpdateResult(
  result: ExtensionUpdateResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

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

/**
 * Renders per-extension progress while updating.
 */
export function renderExtensionUpdateProgress(
  name: string,
  from: string,
  to: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({ status: "updating", name, from, to }, null, 2),
    );
  } else {
    logger.info`Updating ${name}: v${from} -> v${to}`;
  }
}

/**
 * Renders a message when no extensions are installed.
 */
export function renderNoExtensionsInstalled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({ extensions: [], summary: { total: 0 } }, null, 2),
    );
  } else {
    logger.info("No upstream extensions installed.");
    logger.info(
      "Use 'swamp extension pull @namespace/name' to install one.",
    );
  }
}

/**
 * Renders a message when a specific extension is not found locally.
 */
export function renderExtensionNotInstalled(
  name: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({ error: `Extension ${name} is not installed.` }, null, 2),
    );
  } else {
    logger.error`Extension ${name} is not installed.`;
  }
}
