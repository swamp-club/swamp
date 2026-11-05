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
import type {
  TelemetryOptOutSource,
  TelemetryStatsEmptyState,
  TelemetryStatsEvent,
} from "../../libswamp/telemetry/stats.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

const logger = getSwampLogger(["telemetry", "stats"]);

const NO_DATA_MESSAGE = "No telemetry data found";

const KEEP_FLUSHED_KEY = "telemetryKeepFlushed";

/** stats keeps a week of unsent entries at most, so this window covers them */
const QUEUED_ENTRIES_DAYS = 7;

const REENABLE: Record<TelemetryOptOutSource, string> = {
  "telemetry.collection": "swamp config set telemetry.collection enabled",
  SWAMP_NO_TELEMETRY: "unset SWAMP_NO_TELEMETRY",
  DO_NOT_TRACK: "unset DO_NOT_TRACK",
};

function entryCount(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

export function describeEmptyTelemetry(
  state: TelemetryStatsEmptyState,
): string[] {
  if (!state.telemetryEnabled) {
    return [
      `Telemetry is turned off by ${
        state.disabledBy.join(", ")
      }, so nothing is recorded.`,
      `To turn it back on: ${
        state.disabledBy.map((source) => REENABLE[source]).join("; ")
      }.`,
    ];
  }

  const optOut = "No user-level or environment opt-out is set";
  const flush = state.lastFlush;
  if (flush === null) {
    return [`${optOut}, and no flush has been recorded on this machine yet.`];
  }

  const lastSuccess = flush.lastSuccessAt !== undefined
    ? `the last successful flush sent ${
      entryCount(flush.lastSentCount ?? 0)
    } at ${flush.lastSuccessAt}`
    : undefined;

  if (flush.lastAttemptOk) {
    return [
      `${optOut}. Sent entries are removed from the spool; ${lastSuccess}.`,
      `Set ${KEEP_FLUSHED_KEY}: true in a repository's .swamp.yaml to keep sent entries for inspection.`,
    ];
  }

  const reason = flush.lastFailureReason !== undefined
    ? ` (${flush.lastFailureReason})`
    : "";
  const lines = [
    `${optOut}. The last flush attempt at ${flush.lastAttemptAt} failed${reason}; unsent entries stay queued and may be older than the last ${state.daysAnalyzed} days.`,
    `Run swamp telemetry stats --days ${QUEUED_ENTRIES_DAYS} to include them.`,
  ];
  if (lastSuccess !== undefined) {
    lines.push(`Before that, ${lastSuccess}.`);
  }
  return lines;
}

class LogTelemetryStatsRenderer implements Renderer<TelemetryStatsEvent> {
  handlers(): EventHandlers<TelemetryStatsEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (e.data === null) {
          logger.info(`${NO_DATA_MESSAGE}.`);
          if (e.emptyState) {
            for (const line of describeEmptyTelemetry(e.emptyState)) {
              // a recorded failure reason is free text; braces would read as
              // LogTape placeholders
              logger.info(line.replaceAll("{", "{{").replaceAll("}", "}}"));
            }
          }
          return;
        }
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonTelemetryStatsRenderer implements Renderer<TelemetryStatsEvent> {
  handlers(): EventHandlers<TelemetryStatsEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (e.data === null) {
          console.log(
            JSON.stringify(
              {
                message: NO_DATA_MESSAGE,
                ...(e.emptyState
                  ? {
                    telemetryEnabled: e.emptyState.telemetryEnabled,
                    disabledBy: e.emptyState.disabledBy,
                    lastFlush: e.emptyState.lastFlush,
                    keepFlushedKey: KEEP_FLUSHED_KEY,
                  }
                  : {}),
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createTelemetryStatsRenderer(
  mode: OutputMode,
): Renderer<TelemetryStatsEvent> {
  switch (mode) {
    case "json":
      return new JsonTelemetryStatsRenderer();
    case "log":
      return new LogTelemetryStatsRenderer();
  }
}
