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

import { assertEquals } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  telemetryStats,
  type TelemetryStatsDeps,
  type TelemetryStatsEvent,
} from "./stats.ts";
import type { TelemetryStats } from "../../domain/telemetry/telemetry_service.ts";

function makeStats(overrides?: Partial<TelemetryStats>): TelemetryStats {
  return {
    totalInvocations: 10,
    successCount: 8,
    errorCount: 1,
    userErrorCount: 1,
    successRate: 80,
    errorRate: 10,
    commandFrequency: {},
    optionFrequency: {},
    averageDurationByCommand: {},
    platformDistribution: {},
    daysAnalyzed: 2,
    ...overrides,
  };
}

function makeDeps(
  overrides?: Partial<TelemetryStatsDeps>,
): TelemetryStatsDeps {
  return {
    getStats: () => Promise.resolve(makeStats()),
    ...overrides,
  };
}

Deno.test("telemetryStats yields resolving then completed with data", async () => {
  const deps = makeDeps();
  const events = await collect<TelemetryStatsEvent>(
    telemetryStats(createLibSwampContext(), deps, { days: 2 }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    TelemetryStatsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data?.totalInvocations, 10);
});

Deno.test("telemetryStats yields completed with null when no data", async () => {
  const deps = makeDeps({
    getStats: () => Promise.resolve(makeStats({ totalInvocations: 0 })),
  });
  const events = await collect<TelemetryStatsEvent>(
    telemetryStats(createLibSwampContext(), deps, { days: 2 }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    TelemetryStatsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data, null);
});
