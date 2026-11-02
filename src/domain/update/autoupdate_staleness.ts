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

import type { AutoupdateLogEntry } from "./autoupdate_log.ts";
import type { UpdateCadence, UpdatePreferences } from "./update_preferences.ts";

export function cadenceIntervalSeconds(cadence: UpdateCadence): number {
  switch (cadence) {
    case "hourly":
      return 3600;
    case "daily":
      return 86400;
    case "weekly":
      return 604800;
  }
}

/**
 * the shortest age at which a check counts as stale, so an overnight laptop
 * sleep or cron skipping missed runs is not reported as a broken scheduler
 */
export const STALE_CHECK_FLOOR_MS = 72 * 60 * 60 * 1000;

export const SCHEDULER_REFRESH_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * no entry at all is not stale: a freshly enabled scheduler has simply not run
 * yet
 */
export function isLastCheckStale(
  lastEntry: AutoupdateLogEntry | null,
  cadence: UpdateCadence,
  now: Date,
): boolean {
  if (!lastEntry) return false;
  const checkedAt = new Date(lastEntry.timestamp).getTime();
  if (Number.isNaN(checkedAt)) return false;
  const threshold = Math.max(
    2 * cadenceIntervalSeconds(cadence) * 1000,
    STALE_CHECK_FLOOR_MS,
  );
  return now.getTime() - checkedAt > threshold;
}

export function lastCheckAgeDays(
  lastEntry: AutoupdateLogEntry | null,
  now: Date,
): number | null {
  if (!lastEntry) return null;
  const checkedAt = new Date(lastEntry.timestamp).getTime();
  if (Number.isNaN(checkedAt)) return null;
  return Math.floor((now.getTime() - checkedAt) / (24 * 60 * 60 * 1000));
}

export const STALE_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * no warning when this invocation just re-registered the scheduler, which
 * starts a fresh check
 */
export function shouldWarnStaleAutoupdate(input: {
  lastEntry: AutoupdateLogEntry | null;
  cadence: UpdateCadence;
  lastStaleWarning?: string;
  schedulerJustRefreshed: boolean;
  now: Date;
}): boolean {
  if (input.schedulerJustRefreshed) return false;
  if (!isLastCheckStale(input.lastEntry, input.cadence, input.now)) {
    return false;
  }
  if (!input.lastStaleWarning) return true;
  const warnedAt = new Date(input.lastStaleWarning).getTime();
  if (Number.isNaN(warnedAt)) return true;
  return input.now.getTime() - warnedAt >= STALE_WARNING_INTERVAL_MS;
}

export interface SchedulerRefreshInputs {
  os: string;
  prefs: Pick<
    UpdatePreferences,
    "enabled" | "schedulerRefreshedVersion" | "lastSchedulerRefreshAttempt"
  >;
  currentVersion: string;
  installedLaunchdJob: "agent" | "daemon" | null;
  isRoot: boolean;
  configDirOwned: boolean;
  now: Date;
}

/**
 * launchd pins the job to the binary's code signature and ad-hoc signed
 * binaries change it every update, so one re-registration is owed per version;
 * failures retry after a cooldown
 */
export function shouldRefreshScheduler(input: SchedulerRefreshInputs): boolean {
  if (input.os !== "darwin") return false;
  if (!input.prefs.enabled) return false;
  if (!input.configDirOwned) return false;
  if (input.installedLaunchdJob === null) return false;
  // A user agent is refreshed by the user; a LaunchDaemon only by root.
  if ((input.installedLaunchdJob === "daemon") !== input.isRoot) return false;
  if (input.prefs.schedulerRefreshedVersion === input.currentVersion) {
    return false;
  }

  const lastAttempt = input.prefs.lastSchedulerRefreshAttempt;
  if (lastAttempt) {
    const attemptedAt = new Date(lastAttempt).getTime();
    if (
      !Number.isNaN(attemptedAt) &&
      input.now.getTime() - attemptedAt < SCHEDULER_REFRESH_RETRY_MS
    ) {
      return false;
    }
  }
  return true;
}
