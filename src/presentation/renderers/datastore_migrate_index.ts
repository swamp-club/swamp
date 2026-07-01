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

import type { EventHandlers, MigrateIndexEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogDatastoreMigrateIndexRenderer implements Renderer<MigrateIndexEvent> {
  handlers(): EventHandlers<MigrateIndexEvent> {
    const logger = getSwampLogger(["datastore", "migrate-index"]);
    return {
      migrating: () => {
        logger.info`Migrating monolithic index to shard-first format...`;
      },
      completed: (e) => {
        logger
          .info`Migration complete: ${e.data.partitions.length} partition(s), commitSeq=${e.data.commitSeq}`;
      },
      not_supported: (e) => {
        throw new UserError(e.message);
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreMigrateIndexRenderer implements Renderer<MigrateIndexEvent> {
  handlers(): EventHandlers<MigrateIndexEvent> {
    return {
      migrating: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      not_supported: (e) => {
        throw new UserError(e.message);
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDatastoreMigrateIndexRenderer(
  mode: OutputMode,
): Renderer<MigrateIndexEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreMigrateIndexRenderer();
    case "log":
      return new LogDatastoreMigrateIndexRenderer();
  }
}
