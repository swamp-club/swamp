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
  ExtensionInstallEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

const logger = getSwampLogger(["extension", "install"]);

class LogExtensionInstallRenderer implements Renderer<ExtensionInstallEvent> {
  handlers(): EventHandlers<ExtensionInstallEvent> {
    return {
      resolving: () => {
        logger.info("Reading lockfile...");
      },
      installing: (e) => {
        logger.info("Installing {name}@{version}...", {
          name: e.name,
          version: e.version,
        });
      },
      migrating: (e) => {
        logger.info(
          "Migrating {name}@{version} to per-extension layout...",
          {
            name: e.name,
            version: e.version,
          },
        );
      },
      "orphans-pruned": (e) => {
        logger.info(
          "Removed {count} file(s) no longer in {name}@{version}:",
          {
            count: e.paths.length,
            name: e.name,
            version: e.version,
          },
        );
        for (const p of e.paths) {
          logger.info("  {path}", { path: p });
        }
      },
      completed: (e) => {
        const { installed, migrated, upToDate, failed } = e.data;
        if (e.data.entries.length === 0) {
          logger.info("No extensions in lockfile.");
          return;
        }
        if (installed === 0 && migrated === 0 && failed === 0) {
          logger.info("All extensions up to date.");
          return;
        }
        if (installed > 0) {
          logger.info("Installed {count} extension(s).", { count: installed });
        }
        if (migrated > 0) {
          logger.info(
            "Migrated {count} extension(s) to the per-extension layout.",
            { count: migrated },
          );
        }
        if (upToDate > 0) {
          logger.info("{count} extension(s) already up to date.", {
            count: upToDate,
          });
        }
        if (failed > 0) {
          logger.warn("{count} extension(s) failed to install.", {
            count: failed,
          });
          for (const entry of e.data.entries) {
            if (entry.status === "failed") {
              logger.warn("  {name}: {error}", {
                name: entry.name,
                error: entry.error ?? "unknown error",
              });
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

class JsonExtensionInstallRenderer implements Renderer<ExtensionInstallEvent> {
  handlers(): EventHandlers<ExtensionInstallEvent> {
    return {
      resolving: () => {},
      installing: () => {},
      migrating: () => {},
      "orphans-pruned": (e) => {
        console.log(JSON.stringify(
          {
            status: "orphans_pruned",
            name: e.name,
            version: e.version,
            paths: e.paths,
          },
          null,
          2,
        ));
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

export function createExtensionInstallRenderer(
  mode: OutputMode,
): Renderer<ExtensionInstallEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionInstallRenderer();
    case "log":
      return new LogExtensionInstallRenderer();
  }
}
