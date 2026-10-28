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

import type { DatastoreClaimEvent } from "../../libswamp/datastores/claim.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDatastoreClaimRenderer implements Renderer<DatastoreClaimEvent> {
  handlers(): EventHandlers<DatastoreClaimEvent> {
    const logger = getSwampLogger(["datastore", "claim"]);
    return {
      catching_up: () => {
        logger.info`Catching up the commit log...`;
      },
      completed: (e) => {
        if (e.data.alreadyClaimed) {
          logger
            .info`The datastore is already claimed by swamp serve at ${e.data.address} (since ${e.data.claimedAt}); nothing was changed`;
          return;
        }
        logger
          .info`Claimed the datastore for swamp serve at ${e.data.address}, from log position ${e.data.claimedAtCursor}`;
        logger
          .info`Direct writes are refused from now on; clients set serverAddress to ${e.data.address} and run 'swamp auth server-login'`;
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreClaimRenderer implements Renderer<DatastoreClaimEvent> {
  handlers(): EventHandlers<DatastoreClaimEvent> {
    return {
      catching_up: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDatastoreClaimRenderer(
  mode: OutputMode,
): Renderer<DatastoreClaimEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreClaimRenderer();
    case "log":
      return new LogDatastoreClaimRenderer();
  }
}
