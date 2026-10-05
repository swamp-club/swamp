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

/** Seconds between scheduled autoupdate checks for each cadence. */
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
 * The shortest age at which a last check counts as stale, whatever the
 * cadence. Keeps an overnight laptop sleep (or cron skipping the runs it
 * missed) from being reported as a broken scheduler.
 */
export const STALE_CHECK_FLOOR_MS = 72 * 60 * 60 * 1000;

/** Failed scheduler re-registrations are retried at most this often. */
export const SCHEDULER_REFRESH_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the newest autoupdate log entry is older than the scheduler should
 * ever let it get: twice the cadence interval, and never less than
 * {@link STALE_CHECK_FLOOR_MS}. No entry at all is not stale — a freshly
 * enabled scheduler has simply not run yet.
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

/** Whole days since the entry was written, or null without a usable entry. */
export function lastCheckAgeDays(
  lastEntry: AutoupdateLogEntry | null,
  now: Date,
): number | null {
  if (!lastEntry) return null;
  const checkedAt = new Date(lastEntry.timestamp).getTime();
  if (Number.isNaN(checkedAt)) return null;
  return Math.floor((now.getTime() - checkedAt) / (24 * 60 * 60 * 1000));
}

/** The "autoupdate has stopped checking" warning is shown at most this often. */
export const STALE_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether to warn that autoupdate has stopped checking: the last check is
 * stale, the warning was not shown in the last day, and the scheduler was
 * not just re-registered by this invocation (which starts a fresh check).
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
  /** The installed launchd job, or null when none is installed. */
  installedLaunchdJob: "agent" | "daemon" | null;
  isRoot: boolean;
  configDirOwned: boolean;
  now: Date;
}

/**
 * Whether the launchd autoupdate job is owed a re-registration for the
 * running binary.
 *
 * On macOS, launchd can pin the job to the code signature of the binary it
 * last launched. Swamp's binaries are ad-hoc signed, so every update changes
 * that signature and launchd refuses to start the replaced binary until the
 * job is registered again. This is owed once per installed version; a failed
 * attempt is retried after {@link SCHEDULER_REFRESH_RETRY_MS} so a refresh
 * that keeps failing never slows every command.
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
