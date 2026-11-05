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
import { join } from "@std/path";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  createTelemetryStatsDeps,
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
    getLastFlush: () => Promise.resolve(null),
    getOptOutSources: () => Promise.resolve([]),
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

async function completedEvent(
  deps: TelemetryStatsDeps,
  days = 2,
): Promise<Extract<TelemetryStatsEvent, { kind: "completed" }>> {
  const events = await collect<TelemetryStatsEvent>(
    telemetryStats(createLibSwampContext(), deps, { days }),
  );
  return events[1] as Extract<TelemetryStatsEvent, { kind: "completed" }>;
}

const EMPTY = () => Promise.resolve(makeStats({ totalInvocations: 0 }));

Deno.test("telemetryStats: an empty spool with no opt-out reports the last flush", async () => {
  const lastFlush = {
    lastAttemptAt: "2026-11-05T10:00:00.000Z",
    lastAttemptOk: true,
    lastSuccessAt: "2026-11-05T10:00:00.000Z",
    lastSentCount: 3,
  };
  const completed = await completedEvent(
    makeDeps({
      getStats: EMPTY,
      getLastFlush: () => Promise.resolve(lastFlush),
    }),
    5,
  );

  assertEquals(completed.data, null);
  assertEquals(completed.emptyState, {
    telemetryEnabled: true,
    disabledBy: [],
    lastFlush,
    daysAnalyzed: 5,
  });
});

Deno.test("telemetryStats: an empty spool reports every opt-out source", async () => {
  const completed = await completedEvent(
    makeDeps({
      getStats: EMPTY,
      getOptOutSources: () =>
        Promise.resolve(["telemetry.collection", "DO_NOT_TRACK"]),
    }),
  );

  assertEquals(completed.emptyState?.telemetryEnabled, false);
  assertEquals(completed.emptyState?.disabledBy, [
    "telemetry.collection",
    "DO_NOT_TRACK",
  ]);
  assertEquals(completed.emptyState?.lastFlush, null);
});

Deno.test("telemetryStats: a populated spool carries no empty state", async () => {
  let asked = false;
  const completed = await completedEvent(
    makeDeps({
      getLastFlush: () => {
        asked = true;
        return Promise.resolve(null);
      },
    }),
  );

  assertEquals(completed.data?.totalInvocations, 10);
  assertEquals(completed.emptyState, undefined);
  assertEquals(asked, false);
});

async function withConfigDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-stats-optout-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("createTelemetryStatsDeps: reports the user preference and set opt-out env vars", async () => {
  await withConfigDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "telemetry.yaml"), "disabled: true\n");
    await withMockedEnv(
      {
        SWAMP_CONFIG_DIR: dir,
        SWAMP_NO_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
      },
      async () => {
        const deps = createTelemetryStatsDeps("1.0.0");
        assertEquals(await deps.getOptOutSources(), [
          "telemetry.collection",
          "DO_NOT_TRACK",
        ]);
      },
    );
  });
});

Deno.test("createTelemetryStatsDeps: no opt-out and no flush record on a fresh config dir", async () => {
  await withConfigDir(async (dir) => {
    await withMockedEnv(
      {
        SWAMP_CONFIG_DIR: dir,
        SWAMP_NO_TELEMETRY: undefined,
        DO_NOT_TRACK: undefined,
      },
      async () => {
        const deps = createTelemetryStatsDeps("1.0.0");
        assertEquals(await deps.getOptOutSources(), []);
        assertEquals(await deps.getLastFlush(), null);
      },
    );
  });
});
