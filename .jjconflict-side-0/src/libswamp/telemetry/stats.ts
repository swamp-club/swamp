// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { TelemetryStats } from "../../domain/telemetry/telemetry_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

/** Data payload for the completed event. */
export interface TelemetryStatsData extends TelemetryStats {}

export type TelemetryStatsEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: TelemetryStatsData | null }
  | { kind: "error"; error: SwampError };

/** Dependencies for the telemetry stats operation. */
export interface TelemetryStatsDeps {
  getStats: (days: number) => Promise<TelemetryStats>;
}

export interface TelemetryStatsInput {
  days: number;
}

/** Yields telemetry usage statistics. */
export async function* telemetryStats(
  _ctx: LibSwampContext,
  deps: TelemetryStatsDeps,
  input: TelemetryStatsInput,
): AsyncIterable<TelemetryStatsEvent> {
  yield { kind: "resolving" };

  const stats = await deps.getStats(input.days);

  if (stats.totalInvocations === 0) {
    yield { kind: "completed", data: null };
    return;
  }

  yield { kind: "completed", data: stats };
}
