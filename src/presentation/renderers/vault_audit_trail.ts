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

import type {
  EventHandlers,
  VaultAuditTrailEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogVaultAuditTrailRenderer implements Renderer<VaultAuditTrailEvent> {
  handlers(): EventHandlers<VaultAuditTrailEvent> {
    const logger = getSwampLogger(["vault", "audit-trail"]);
    return {
      resolving: () => {},
      completed: (e) => {
        if (e.data.entries.length === 0) {
          logger.info`No vault read audit entries found.`;
          return;
        }
        logger.info`${e.data.totalCount} vault read(s):`;
        for (const entry of e.data.entries) {
          logger
            .info`  ${entry.timestamp}  ${entry.vaultName}/${entry.secretKey}  by ${entry.callerContext}`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonVaultAuditTrailRenderer implements Renderer<VaultAuditTrailEvent> {
  handlers(): EventHandlers<VaultAuditTrailEvent> {
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

export function createVaultAuditTrailRenderer(
  mode: OutputMode,
): Renderer<VaultAuditTrailEvent> {
  switch (mode) {
    case "json":
      return new JsonVaultAuditTrailRenderer();
    case "log":
      return new LogVaultAuditTrailRenderer();
  }
}
