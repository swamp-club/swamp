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
import type { ExtensionVisibilityEvent } from "../../libswamp/extensions/visibility.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogExtensionVisibilityRenderer
  implements Renderer<ExtensionVisibilityEvent> {
  handlers(): EventHandlers<ExtensionVisibilityEvent> {
    const logger = getSwampLogger(["extension", "visibility"]);
    return {
      completed: (e) => {
        const { name, before, after, changed, dryRun, requested } = e.data;
        if (requested) {
          logger.warn(
            "Requested {requested}, but the registry kept {name} {after}",
            { requested, name, after },
          );
        }
        if (dryRun && changed) {
          logger.info(
            "Would change {name} visibility: {before} → {after} (dry run, nothing changed)",
            { name, before, after },
          );
        } else if (changed) {
          logger.info("{name} visibility: {before} → {after}", {
            name,
            before,
            after,
          });
          if (after === "public") {
            logger.info("Anyone can now pull {name}", { name });
          } else {
            logger.info("Only collective members can now pull {name}", {
              name,
            });
          }
        } else {
          logger.info("{name} is {after}", { name, after });
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionVisibilityRenderer
  implements Renderer<ExtensionVisibilityEvent> {
  handlers(): EventHandlers<ExtensionVisibilityEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionVisibilityRenderer(
  mode: OutputMode,
): Renderer<ExtensionVisibilityEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionVisibilityRenderer();
    case "log":
      return new LogExtensionVisibilityRenderer();
  }
}

export function renderExtensionVisibilityCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    getSwampLogger(["extension", "visibility"]).info(
      "Visibility change cancelled.",
    );
  }
}
