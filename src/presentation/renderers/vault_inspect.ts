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

import type { EventHandlers, VaultInspectEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogVaultInspectRenderer implements Renderer<VaultInspectEvent> {
  handlers(): EventHandlers<VaultInspectEvent> {
    const logger = getSwampLogger(["vault", "inspect"]);
    return {
      resolving: () => {},
      completed: (e) => {
        if (!e.data.hasAnnotation || !e.data.annotation) {
          logger
            .info`No annotation found for ${e.data.secretKey} in vault ${e.data.vaultName}`;
          return;
        }
        const a = e.data.annotation;
        logger
          .info`Annotation for ${e.data.secretKey} in vault ${e.data.vaultName}:`;
        if (a.url) logger.info`  url: ${a.url}`;
        if (a.notes) logger.info`  notes: ${a.notes}`;
        if (a.labels && Object.keys(a.labels).length > 0) {
          for (const [k, v] of Object.entries(a.labels)) {
            logger.info`  label: ${k}=${v}`;
          }
        }
        logger.info`  updated: ${a.updatedAt}`;
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonVaultInspectRenderer implements Renderer<VaultInspectEvent> {
  handlers(): EventHandlers<VaultInspectEvent> {
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

export function createVaultInspectRenderer(
  mode: OutputMode,
): Renderer<VaultInspectEvent> {
  switch (mode) {
    case "json":
      return new JsonVaultInspectRenderer();
    case "log":
      return new LogVaultInspectRenderer();
  }
}
