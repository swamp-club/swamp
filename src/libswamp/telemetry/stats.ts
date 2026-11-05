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

import {
  TelemetryService,
  type TelemetryStats,
} from "../../domain/telemetry/telemetry_service.ts";
import type { TelemetryFlushRecord } from "../../domain/telemetry/telemetry_flush_record.ts";
import { JsonTelemetryFlushRecordRepository } from "../../infrastructure/persistence/json_telemetry_flush_record_repository.ts";
import { JsonTelemetryRepository } from "../../infrastructure/persistence/json_telemetry_repository.ts";
import { TelemetryPreferencesFileRepository } from "../../infrastructure/persistence/telemetry_preferences_file_repository.ts";
import { telemetryOptOutEnvVarsSet } from "../../infrastructure/telemetry/telemetry_opt_out_env.ts";
import { globalTelemetryDir } from "../../infrastructure/persistence/paths.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export interface TelemetryStatsData extends TelemetryStats {}

/** the user-level preference key, or an opt-out environment variable */
export type TelemetryOptOutSource =
  | "telemetry.collection"
  | "SWAMP_NO_TELEMETRY"
  | "DO_NOT_TRACK";

/**
 * why the spool holds nothing to count; a repository's telemetryDisabled and
 * --no-telemetry are invisible to this repo-free command
 */
export interface TelemetryStatsEmptyState {
  telemetryEnabled: boolean;
  disabledBy: TelemetryOptOutSource[];
  lastFlush: TelemetryFlushRecord | null;
  daysAnalyzed: number;
}

export type TelemetryStatsEvent =
  | { kind: "resolving" }
  | {
    kind: "completed";
    data: TelemetryStatsData | null;
    emptyState?: TelemetryStatsEmptyState;
  }
  | { kind: "error"; error: SwampError };

export interface TelemetryStatsDeps {
  getStats: (days: number) => Promise<TelemetryStats>;
  getLastFlush: () => Promise<TelemetryFlushRecord | null>;
  getOptOutSources: () => Promise<TelemetryOptOutSource[]>;
}

export interface TelemetryStatsInput {
  days: number;
}

export function createTelemetryStatsDeps(
  version: string,
): TelemetryStatsDeps {
  // Telemetry is user-global; the spool location does not depend on any repo.
  // The repository's repoDir arg only feeds the default baseDir, which we
  // override with the global spool, so it is unused here.
  const repository = new JsonTelemetryRepository("", globalTelemetryDir());
  const service = new TelemetryService(repository, version);
  const flushRecords = new JsonTelemetryFlushRecordRepository(
    globalTelemetryDir(),
  );
  return {
    getStats: (days: number) => service.getStats(days),
    getLastFlush: () => flushRecords.read(),
    getOptOutSources: async () => {
      const prefs = await new TelemetryPreferencesFileRepository().read();
      const sources: TelemetryOptOutSource[] = prefs.disabled
        ? ["telemetry.collection"]
        : [];
      return [...sources, ...telemetryOptOutEnvVarsSet()];
    },
  };
}

export async function* telemetryStats(
  _ctx: LibSwampContext,
  deps: TelemetryStatsDeps,
  input: TelemetryStatsInput,
): AsyncIterable<TelemetryStatsEvent> {
  yield* withGeneratorSpan(
    "swamp.telemetry.stats",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const stats = await deps.getStats(input.days);

      if (stats.totalInvocations === 0) {
        const disabledBy = await deps.getOptOutSources();
        yield {
          kind: "completed",
          data: null,
          emptyState: {
            telemetryEnabled: disabledBy.length === 0,
            disabledBy,
            lastFlush: await deps.getLastFlush(),
            daysAnalyzed: input.days,
          },
        };
        return;
      }

      yield { kind: "completed", data: stats };
    })(),
  );
}
