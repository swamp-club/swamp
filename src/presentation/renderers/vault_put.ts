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

import type { EventHandlers, VaultPutEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogVaultPutRenderer implements Renderer<VaultPutEvent> {
  handlers(): EventHandlers<VaultPutEvent> {
    const logger = getSwampLogger(["vault", "put"]);
    return {
      storing: () => {},
      completed: (e) => {
        logger
          .info`Stored secret ${e.data.secretKey} in vault ${e.data.vaultName}`;
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonVaultPutRenderer implements Renderer<VaultPutEvent> {
  handlers(): EventHandlers<VaultPutEvent> {
    return {
      storing: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createVaultPutRenderer(
  mode: OutputMode,
): Renderer<VaultPutEvent> {
  switch (mode) {
    case "json":
      return new JsonVaultPutRenderer();
    case "log":
      return new LogVaultPutRenderer();
  }
}

/** Renders cancellation when user declines the prompt. */
export function renderVaultPutCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["vault", "put"]);
    logger.info("Operation cancelled.");
  }
}
