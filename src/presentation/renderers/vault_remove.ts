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

import type { EventHandlers } from "../../libswamp/stream.ts";
import type { VaultRemoveEvent } from "../../libswamp/vaults/remove.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogVaultRemoveRenderer implements Renderer<VaultRemoveEvent> {
  handlers(): EventHandlers<VaultRemoveEvent> {
    const logger = getSwampLogger(["vault", "remove"]);
    return {
      removing: () => {},
      completed: (e) => {
        const { data } = e;
        logger.info`Removed vault ${data.vaultName} (${data.vaultType})`;
        if (!data.secrets) {
          logger
            .info`Only the local config was removed; secrets stored by ${data.vaultType} were left in place`;
        } else if (data.secrets.removed) {
          logger
            .info`Deleted ${data.secrets.secretCount} secret(s) and the vault's key from ${data.secrets.directory}`;
        } else {
          logger.info`The vault had no stored secrets`;
        }
        for (const ref of data.forcedReferences) {
          logger
            .warn`Still referenced by ${ref.kind} ${ref.name} (${ref.via}); it will fail until the reference is removed`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonVaultRemoveRenderer implements Renderer<VaultRemoveEvent> {
  handlers(): EventHandlers<VaultRemoveEvent> {
    return {
      removing: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createVaultRemoveRenderer(
  mode: OutputMode,
): Renderer<VaultRemoveEvent> {
  switch (mode) {
    case "json":
      return new JsonVaultRemoveRenderer();
    case "log":
      return new LogVaultRemoveRenderer();
  }
}

export function renderVaultRemoveCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["vault", "remove"]);
    logger.info("Operation cancelled.");
  }
}
