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

import type { DatastoreReleaseEvent } from "../../libswamp/datastores/release.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDatastoreReleaseRenderer implements Renderer<DatastoreReleaseEvent> {
  handlers(): EventHandlers<DatastoreReleaseEvent> {
    const logger = getSwampLogger(["datastore", "release"]);
    return {
      completed: (e) => {
        if (!e.data.released) {
          logger
            .info`The datastore is not claimed; nothing was changed`;
          return;
        }
        if (e.data.address === undefined) {
          logger
            .info`Removed a claim that could not be read; direct writes work again`;
          return;
        }
        logger
          .info`Released the claim of swamp serve at ${e.data.address} (since ${e.data.claimedAt}); direct writes work again`;
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreReleaseRenderer implements Renderer<DatastoreReleaseEvent> {
  handlers(): EventHandlers<DatastoreReleaseEvent> {
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

export function createDatastoreReleaseRenderer(
  mode: OutputMode,
): Renderer<DatastoreReleaseEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreReleaseRenderer();
    case "log":
      return new LogDatastoreReleaseRenderer();
  }
}
