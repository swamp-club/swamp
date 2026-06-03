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

import { bold } from "@std/fmt/colors";
import type { EventHandlers, NamespaceUnsetEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

class LogNamespaceUnsetRenderer implements Renderer<NamespaceUnsetEvent> {
  handlers(): EventHandlers<NamespaceUnsetEvent> {
    return {
      completed: (e) => {
        writeOutput(
          bold("Namespace unset") +
            ` (was "${e.data.previousNamespace}")`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonNamespaceUnsetRenderer implements Renderer<NamespaceUnsetEvent> {
  handlers(): EventHandlers<NamespaceUnsetEvent> {
    return {
      completed: (e) => {
        writeOutput(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createNamespaceUnsetRenderer(
  mode: OutputMode,
): Renderer<NamespaceUnsetEvent> {
  switch (mode) {
    case "json":
      return new JsonNamespaceUnsetRenderer();
    case "log":
      return new LogNamespaceUnsetRenderer();
  }
}
