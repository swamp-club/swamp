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

import type { EventHandlers, VaultMigrateEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogVaultMigrateRenderer implements Renderer<VaultMigrateEvent> {
  handlers(): EventHandlers<VaultMigrateEvent> {
    const logger = getSwampLogger(["vault", "migrate"]);
    return {
      copying_secret: (e) => {
        logger.info`Copying secret ${e.index}/${e.total}: ${e.key}`;
      },
      updating_config: () => {
        logger.info`Updating vault configuration...`;
      },
      completed: (e) => {
        logger
          .info`Migrated vault ${e.data.vaultName} from ${e.data.previousType} to ${e.data.newType} (${e.data.secretsMigrated} secrets)`;
        logger
          .info`All existing vault references continue to work — no changes needed.`;
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonVaultMigrateRenderer implements Renderer<VaultMigrateEvent> {
  handlers(): EventHandlers<VaultMigrateEvent> {
    return {
      copying_secret: () => {},
      updating_config: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createVaultMigrateRenderer(
  mode: OutputMode,
): Renderer<VaultMigrateEvent> {
  switch (mode) {
    case "json":
      return new JsonVaultMigrateRenderer();
    case "log":
      return new LogVaultMigrateRenderer();
  }
}

/** Renders cancellation when user declines the prompt. */
export function renderVaultMigrateCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["vault", "migrate"]);
    logger.info("Operation cancelled.");
  }
}
