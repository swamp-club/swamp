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

import type { EventHandlers, TrustModifyEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogTrustModifyRenderer implements Renderer<TrustModifyEvent> {
  handlers(): EventHandlers<TrustModifyEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const verb = e.data.action === "added" ? "Added" : "Removed";
        writeOutput(
          `${verb} trusted collective: ${e.data.collective}`,
        );
        writeOutput(
          `Trusted collectives: ${
            e.data.trustedCollectives.join(", ") || "(none)"
          }`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonTrustModifyRenderer implements Renderer<TrustModifyEvent> {
  handlers(): EventHandlers<TrustModifyEvent> {
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

export function createTrustModifyRenderer(
  mode: OutputMode,
): Renderer<TrustModifyEvent> {
  switch (mode) {
    case "json":
      return new JsonTrustModifyRenderer();
    case "log":
      return new LogTrustModifyRenderer();
  }
}
