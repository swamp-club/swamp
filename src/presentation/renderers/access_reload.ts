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

const logger = getSwampLogger(["access", "reload"]);

export interface AccessReloadResult {
  success: boolean;
  grantCount: number;
  groupCount: number;
}

export interface AccessReloadRenderer {
  render(result: AccessReloadResult): void;
}

class LogAccessReloadRenderer implements AccessReloadRenderer {
  render(result: AccessReloadResult): void {
    logger
      .info`Policy snapshot reloaded: ${result.grantCount} grant(s), ${result.groupCount} group(s)`;
  }
}

class JsonAccessReloadRenderer implements AccessReloadRenderer {
  render(result: AccessReloadResult): void {
    writeOutput(
      JSON.stringify(
        {
          success: result.success,
          grantCount: result.grantCount,
          groupCount: result.groupCount,
        },
        null,
        2,
      ),
    );
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
