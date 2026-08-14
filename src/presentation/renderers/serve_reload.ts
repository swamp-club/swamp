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
import type { ServeReloadResponse } from "../../serve/protocol.ts";

const logger = getSwampLogger(["serve", "reload"]);

export interface ServeReloadRenderer {
  render(result: ServeReloadResponse): void;
}

class LogServeReloadRenderer implements ServeReloadRenderer {
  render(result: ServeReloadResponse): void {
    if (!result.success) {
      logger.error`Extension reload failed`;
      for (const error of result.errors) {
        logger.error`${error}`;
      }
      return;
    }

    logger.info`Reloaded ${result.reloadedCount} extension type(s)`;

    if (result.triggerOverridesChanged && result.triggerOverridesChanged > 0) {
      logger.info(
        "Reloaded {count} trigger override(s) from serve.yaml",
        { count: result.triggerOverridesChanged },
      );
    }

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        logger.warn`${error}`;
      }
    }
  }
}

class JsonServeReloadRenderer implements ServeReloadRenderer {
  render(result: ServeReloadResponse): void {
    writeOutput(JSON.stringify(result, null, 2));
  }
}

export function createServeReloadRenderer(
  mode: OutputMode,
): ServeReloadRenderer {
  switch (mode) {
    case "json":
      return new JsonServeReloadRenderer();
    case "log":
      return new LogServeReloadRenderer();
  }
}
