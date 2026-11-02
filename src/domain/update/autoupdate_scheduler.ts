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
  running: boolean;
  lastExitCode: number | null;
  needsRepair: boolean;
  /**
   * The OS has pinned the job to the code signature of the binary it last
   * started, so a replaced binary will be refused until the job is
   * registered again.
   */
  pinnedToBinary: boolean;
}

export const SCHEDULER_EX_CONFIG = 78;

/**
 * refreshed: re-registered; not_needed: healthy and unpinned; skipped: job
 * running; unknown: scheduler report unreadable; not_installed: no job, or no
 * re-registration needed
 */
export type SchedulerRefreshResult =
  | "refreshed"
  | "not_needed"
  | "skipped"
  | "unknown"
  | "not_installed";

/**
 * leftUnloaded is true when the job was removed from the scheduler and could
 * not be loaded again, so the next attempt should load it
 */
export class SchedulerRefreshError extends Error {
  readonly leftUnloaded: boolean;

  constructor(message: string, leftUnloaded: boolean) {
    super(message);
    this.name = "SchedulerRefreshError";
    this.leftUnloaded = leftUnloaded;
  }
}

export interface SchedulerRefreshOptions {
  loadIfNotLoaded?: boolean;
  /**
   * called just before the job is taken out of the scheduler, so the caller can
   * record that it may be left unloaded if this process dies before loading it
   * again
   */
  beforeUnload?: () => Promise<void>;
}

export interface AutoupdateScheduler {
  install(binaryPath: string, cadence: UpdateCadence): Promise<void>;
  remove(): Promise<void>;
  status(): Promise<ScheduleStatus>;
  /**
   * loadIfNotLoaded also loads a job the OS does not have; set it only when an
   * earlier refresh left the job unloaded
   */
  refresh(options?: SchedulerRefreshOptions): Promise<SchedulerRefreshResult>;
}

// TODO(windows): Implement Windows Task Scheduler support when swamp update
// ships for Windows. Implement the AutoupdateScheduler interface using
// schtasks.exe or the Task Scheduler COM API.
