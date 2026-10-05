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
import type { AutoupdateLogEntry } from "./autoupdate_log.ts";
import {
  cadenceIntervalSeconds,
  isLastCheckStale,
  SCHEDULER_REFRESH_RETRY_MS,
  type SchedulerRefreshInputs,
  shouldRefreshScheduler,
  STALE_CHECK_FLOOR_MS,
} from "./autoupdate_staleness.ts";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-10-05T12:00:00.000Z");

function entryAgo(ms: number): AutoupdateLogEntry {
  return {
    timestamp: new Date(NOW.getTime() - ms).toISOString(),
    versionBefore: "20261001.000000.0-sha.aaa",
    versionAfter: null,
    outcome: "up_to_date",
  };
}

Deno.test("cadenceIntervalSeconds: matches the scheduler intervals", () => {
  assertEquals(cadenceIntervalSeconds("hourly"), 3600);
  assertEquals(cadenceIntervalSeconds("daily"), 86400);
  assertEquals(cadenceIntervalSeconds("weekly"), 604800);
});

Deno.test("isLastCheckStale: no entry is not stale", () => {
  assertEquals(isLastCheckStale(null, "daily", NOW), false);
});

Deno.test("isLastCheckStale: unparseable timestamp is not stale", () => {
  const entry = { ...entryAgo(0), timestamp: "not-a-date" };
  assertEquals(isLastCheckStale(entry, "daily", NOW), false);
});

Deno.test("isLastCheckStale: hourly and daily use the 72h floor", () => {
  for (const cadence of ["hourly", "daily"] as const) {
    assertEquals(
      isLastCheckStale(entryAgo(STALE_CHECK_FLOOR_MS), cadence, NOW),
      false,
    );
    assertEquals(
      isLastCheckStale(entryAgo(STALE_CHECK_FLOOR_MS + 1), cadence, NOW),
      true,
    );
  }
});

Deno.test("isLastCheckStale: an overnight sleep is not stale for hourly", () => {
  assertEquals(isLastCheckStale(entryAgo(10 * HOUR_MS), "hourly", NOW), false);
});

Deno.test("isLastCheckStale: weekly uses twice the cadence", () => {
  const twoWeeks = 2 * 604800 * 1000;
  assertEquals(isLastCheckStale(entryAgo(twoWeeks), "weekly", NOW), false);
  assertEquals(isLastCheckStale(entryAgo(twoWeeks + 1), "weekly", NOW), true);
});

Deno.test("isLastCheckStale: a month-old daily check is stale", () => {
  assertEquals(
    isLastCheckStale(entryAgo(30 * 24 * HOUR_MS), "daily", NOW),
    true,
  );
});

function refreshInputs(
  overrides: Partial<SchedulerRefreshInputs> = {},
): SchedulerRefreshInputs {
  return {
    os: "darwin",
    prefs: { enabled: true },
    currentVersion: "20261005.120000.0-sha.bbb",
    installedLaunchdJob: "agent",
    isRoot: false,
    configDirOwned: true,
    now: NOW,
    ...overrides,
  };
}

Deno.test("shouldRefreshScheduler: owed for a user agent on a new version", () => {
  assertEquals(shouldRefreshScheduler(refreshInputs()), true);
});

Deno.test("shouldRefreshScheduler: not owed once refreshed for this version", () => {
  assertEquals(
    shouldRefreshScheduler(refreshInputs({
      prefs: {
        enabled: true,
        schedulerRefreshedVersion: "20261005.120000.0-sha.bbb",
      },
    })),
    false,
  );
});

Deno.test("shouldRefreshScheduler: owed again after a newer version", () => {
  assertEquals(
    shouldRefreshScheduler(refreshInputs({
      prefs: {
        enabled: true,
        schedulerRefreshedVersion: "20261001.000000.0-sha.aaa",
      },
    })),
    true,
  );
});

Deno.test("shouldRefreshScheduler: never off macOS", () => {
  assertEquals(shouldRefreshScheduler(refreshInputs({ os: "linux" })), false);
});

Deno.test("shouldRefreshScheduler: not when autoupdate is disabled", () => {
  assertEquals(
    shouldRefreshScheduler(refreshInputs({ prefs: { enabled: false } })),
    false,
  );
});

Deno.test("shouldRefreshScheduler: not when no launchd job is installed", () => {
  assertEquals(
    shouldRefreshScheduler(refreshInputs({ installedLaunchdJob: null })),
    false,
  );
});

Deno.test("shouldRefreshScheduler: not when the config dir is not owned", () => {
  assertEquals(
    shouldRefreshScheduler(refreshInputs({ configDirOwned: false })),
    false,
  );
});

Deno.test("shouldRefreshScheduler: privileges must match the job type", () => {
  assertEquals(
    shouldRefreshScheduler(refreshInputs({ isRoot: true })),
    false,
  );
  assertEquals(
    shouldRefreshScheduler(refreshInputs({ installedLaunchdJob: "daemon" })),
    false,
  );
  assertEquals(
    shouldRefreshScheduler(
      refreshInputs({ installedLaunchdJob: "daemon", isRoot: true }),
    ),
    true,
  );
});

Deno.test("shouldRefreshScheduler: waits 24h after a failed attempt", () => {
  const attemptedAgo = (ms: number) =>
    refreshInputs({
      prefs: {
        enabled: true,
        lastSchedulerRefreshAttempt: new Date(NOW.getTime() - ms)
          .toISOString(),
      },
    });
  assertEquals(shouldRefreshScheduler(attemptedAgo(HOUR_MS)), false);
  assertEquals(
    shouldRefreshScheduler(attemptedAgo(SCHEDULER_REFRESH_RETRY_MS)),
    true,
  );
});

Deno.test("shouldRefreshScheduler: ignores an unparseable attempt timestamp", () => {
  assertEquals(
    shouldRefreshScheduler(refreshInputs({
      prefs: { enabled: true, lastSchedulerRefreshAttempt: "garbage" },
    })),
    true,
  );
});
