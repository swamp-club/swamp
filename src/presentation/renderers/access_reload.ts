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

import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { AccessReloadFileResult } from "../../serve/protocol.ts";

const logger = getSwampLogger(["access", "reload"]);

export interface AccessReloadResult {
  success: boolean;
  grantCount: number;
  groupCount: number;
  filesProcessed?: number;
  fileResults?: AccessReloadFileResult[];
  errors?: string[];
}

export interface AccessReloadRenderer {
  render(result: AccessReloadResult): void;
}

class LogAccessReloadRenderer implements AccessReloadRenderer {
  render(result: AccessReloadResult): void {
    if (!result.success && result.errors) {
      logger.error`Reconciliation aborted. Current policy unchanged.`;
      for (const error of result.errors) {
        logger.error`${error}`;
      }
      return;
    }

    if (result.fileResults && result.fileResults.length > 0) {
      for (const fr of result.fileResults) {
        logger
          .info`Reading grants/${fr.filename}... ${fr.entryCount} grant(s)`;
      }
      logger.info`Validating... ok`;

      const totalCreated = result.fileResults.reduce(
        (s, f) => s + f.created,
        0,
      );
      const totalRevoked = result.fileResults.reduce(
        (s, f) => s + f.revoked,
        0,
      );
      const totalReactivated = result.fileResults.reduce(
        (s, f) => s + f.reactivated,
        0,
      );
      const totalUnchanged = result.fileResults.reduce(
        (s, f) => s + f.unchanged,
        0,
      );
      logger
        .info`Reconciling files: ${totalCreated} created, ${totalRevoked} revoked, ${totalReactivated} reactivated, ${totalUnchanged} unchanged`;
    }

    logger
      .info`Policy snapshot reloaded: ${result.grantCount} grant(s), ${result.groupCount} group(s)`;
  }
}

class JsonAccessReloadRenderer implements AccessReloadRenderer {
  render(result: AccessReloadResult): void {
    const output: Record<string, unknown> = {
      success: result.success,
      grantCount: result.grantCount,
      groupCount: result.groupCount,
    };
    if (result.filesProcessed !== undefined) {
      output.filesProcessed = result.filesProcessed;
    }
    if (result.fileResults) {
      output.fileResults = result.fileResults;
    }
    if (result.errors) {
      output.errors = result.errors;
    }
    writeOutput(JSON.stringify(output, null, 2));
  }
}

export function createAccessReloadRenderer(
  mode: OutputMode,
): AccessReloadRenderer {
  switch (mode) {
    case "json":
      return new JsonAccessReloadRenderer();
    case "log":
      return new LogAccessReloadRenderer();
  }
}
