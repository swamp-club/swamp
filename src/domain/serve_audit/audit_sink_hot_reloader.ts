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

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { AuditSink } from "./audit_sink.ts";

const logger = getSwampLogger(["serve", "audit", "hot-reload"]);

export class AuditSinkHotReloader {
  async reload(
    currentSinks: AuditSink[],
    buildNewSinks: () => Promise<AuditSink[]>,
  ): Promise<AuditSink[]> {
    let newSinks: AuditSink[];
    try {
      newSinks = await buildNewSinks();
    } catch (error: unknown) {
      logger.warn(
        "Failed to build new audit sinks, keeping current sinks: {error}",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return currentSinks;
    }

    for (const sink of currentSinks) {
      try {
        await sink.flush();
      } catch (error: unknown) {
        logger.warn(
          "Audit sink {sink} flush failed during hot-reload: {error}",
          {
            sink: sink.name,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    for (const sink of currentSinks) {
      try {
        await sink.close();
      } catch (error: unknown) {
        logger.warn(
          "Audit sink {sink} close failed during hot-reload: {error}",
          {
            sink: sink.name,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    return newSinks;
  }
}
