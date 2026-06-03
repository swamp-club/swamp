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

import type { EventHandlers, ExtensionRmEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

/** Extended renderer interface with dependency warning support. */
export interface ExtensionRmRenderer extends Renderer<ExtensionRmEvent> {
  renderDependencyWarning(dependents: string[]): void;
}

class LogExtensionRmRenderer implements ExtensionRmRenderer {
  readonly #logger = getSwampLogger(["extension", "rm"]);

  handlers(): EventHandlers<ExtensionRmEvent> {
    return {
      deleting: () => {},
      completed: (e) => {
        this.#logger.info(
          "Removed {name} (v{version}) — deleted {count} file(s)",
          {
            name: e.data.name,
            version: e.data.version,
            count: e.data.filesDeleted,
          },
        );
        if (e.data.filesSkipped > 0) {
          this.#logger.info("{count} file(s) already missing, skipped", {
            count: e.data.filesSkipped,
          });
        }
        if (e.data.dirsRemoved > 0) {
          this.#logger.info("Pruned {count} empty directory(ies)", {
            count: e.data.dirsRemoved,
          });
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  renderDependencyWarning(dependents: string[]): void {
    this.#logger.warn(
      "The following installed extensions depend on this extension:",
    );
    for (const dep of dependents) {
      this.#logger.warn("  {dep}", { dep });
    }
  }
}

class JsonExtensionRmRenderer implements ExtensionRmRenderer {
  handlers(): EventHandlers<ExtensionRmEvent> {
    return {
      deleting: () => {},
      completed: (e) => {
        console.log(JSON.stringify({ removed: e.data }, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  renderDependencyWarning(dependents: string[]): void {
    console.log(JSON.stringify({ dependencyWarning: dependents }, null, 2));
  }
}

export function createExtensionRmRenderer(
  mode: OutputMode,
): ExtensionRmRenderer {
  switch (mode) {
    case "json":
      return new JsonExtensionRmRenderer();
    case "log":
      return new LogExtensionRmRenderer();
  }
}

/** Renders cancellation when user declines the prompt. */
export function renderExtensionRmCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    const logger = getSwampLogger(["extension", "rm"]);
    logger.info("Removal cancelled.");
  }
}
