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
  ExtensionPromoteEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogExtensionPromoteRenderer implements Renderer<ExtensionPromoteEvent> {
  handlers(): EventHandlers<ExtensionPromoteEvent> {
    const logger = getSwampLogger(["extension", "promote"]);
    return {
      promoting: () => {
        logger.info`Promoting...`;
      },
      completed: (e) => {
        logger.info(
          "Promoted {name}@{version} from {previousChannel} to {channel}",
          {
            name: e.data.name,
            version: e.data.version,
            previousChannel: e.data.previousChannel,
            channel: e.data.channel,
          },
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionPromoteRenderer implements Renderer<ExtensionPromoteEvent> {
  handlers(): EventHandlers<ExtensionPromoteEvent> {
    return {
      promoting: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionPromoteRenderer(
  mode: OutputMode,
): Renderer<ExtensionPromoteEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionPromoteRenderer();
    case "log":
      return new LogExtensionPromoteRenderer();
  }
}
