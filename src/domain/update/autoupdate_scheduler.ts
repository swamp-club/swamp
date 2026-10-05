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

import type { UpdateCadence } from "./update_preferences.ts";

export interface ScheduleStatus {
  installed: boolean;
  cadence?: UpdateCadence;
  nextRun?: string;
  /**
   * Runtime facts from the OS scheduler. Omitted when the scheduler cannot
   * report them (systemd, cron) or the query failed.
   */
  runtime?: SchedulerRuntime;
}

export interface SchedulerRuntime {
  /** Whether the job is currently running. */
  running: boolean;
  /** Exit code of the last run, or null when it has never exited. */
  lastExitCode: number | null;
  /** The OS refuses to start the job until it is registered again. */
  needsRepair: boolean;
  /**
   * The OS has pinned the job to the code signature of the binary it last
   * started, so a replaced binary will be refused until the job is
   * registered again.
   */
  pinnedToBinary: boolean;
}

/** Exit code a scheduler reports when it refused to start the job. */
export const SCHEDULER_EX_CONFIG = 78;

/**
 * Result of re-registering the scheduled job after the binary changed:
 * `refreshed` — re-registered; `not_needed` — the job is healthy and not
 * pinned to a binary, so it was left as it is; `skipped` — the job is
 * running, so it was left alone for now; `unknown` — the scheduler's
 * report on the job could not be read, so it was left alone;
 * `not_installed` — no job to refresh, or the scheduler needs no
 * re-registration.
 */
export type SchedulerRefreshResult =
  | "refreshed"
  | "not_needed"
  | "skipped"
  | "unknown"
  | "not_installed";

export interface AutoupdateScheduler {
  install(binaryPath: string, cadence: UpdateCadence): Promise<void>;
  remove(): Promise<void>;
  status(): Promise<ScheduleStatus>;
  /** Re-register the job so the OS will start the binary now at its path. */
  refresh(): Promise<SchedulerRefreshResult>;
}

// TODO(windows): Implement Windows Task Scheduler support when swamp update
// ships for Windows. Implement the AutoupdateScheduler interface using
// schtasks.exe or the Task Scheduler COM API.
