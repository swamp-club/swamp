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

import type { SchedulerRefreshResult } from "../domain/update/autoupdate_scheduler.ts";
import { shouldRefreshScheduler } from "../domain/update/autoupdate_staleness.ts";
import type { UpdatePreferences } from "../domain/update/update_preferences.ts";
import { processOwnsConfigDir } from "../infrastructure/persistence/config_dir_ownership.ts";
import {
  detectInstalledLaunchdMode,
  LaunchdScheduler,
} from "../infrastructure/update/launchd_scheduler.ts";
import { isRunningAsRoot } from "../infrastructure/update/scheduler_factory.ts";
import { UpdatePreferencesFileRepository } from "../infrastructure/update/update_preferences_file_repository.ts";

type LaunchdJob = "agent" | "daemon";

export interface AutoupdateRefreshDeps {
  os: string;
  readPreferences(): Promise<UpdatePreferences>;
  writePreferences(preferences: UpdatePreferences): Promise<void>;
  detectInstalledLaunchdJob(): Promise<LaunchdJob | null>;
  isRoot(): boolean;
  configDirOwned(): boolean;
  refreshScheduler(job: LaunchdJob): Promise<SchedulerRefreshResult>;
  now(): Date;
}

export type AutoupdateRefreshOutcome =
  | { outcome: "refreshed" }
  | { outcome: "skipped" }
  | { outcome: "not_owed" }
  | { outcome: "failed"; job: LaunchdJob; error: string };

/**
 * Re-registers the macOS autoupdate job for `installedVersion` when one is
 * owed (see shouldRefreshScheduler). Records the version on success and the
 * attempt time on failure, so a refresh that keeps failing is retried daily
 * rather than on every command. A running job is left alone and retried by
 * the next command. Never throws.
 */
export async function refreshAutoupdateSchedulerIfOwed(
  deps: AutoupdateRefreshDeps,
  installedVersion: string,
): Promise<AutoupdateRefreshOutcome> {
  if (deps.os !== "darwin") return { outcome: "not_owed" };

  try {
    const prefs = await deps.readPreferences();
    const job = await deps.detectInstalledLaunchdJob();
    const owed = shouldRefreshScheduler({
      os: deps.os,
      prefs,
      currentVersion: installedVersion,
      installedLaunchdJob: job,
      isRoot: deps.isRoot(),
      configDirOwned: deps.configDirOwned(),
      now: deps.now(),
    });
    if (!owed || job === null) return { outcome: "not_owed" };

    let result: SchedulerRefreshResult;
    try {
      result = await deps.refreshScheduler(job);
    } catch (error) {
      await deps.writePreferences({
        ...prefs,
        lastSchedulerRefreshAttempt: deps.now().toISOString(),
      });
      return {
        outcome: "failed",
        job,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (result === "skipped") return { outcome: "skipped" };
    if (result === "not_installed") return { outcome: "not_owed" };

    await deps.writePreferences({
      ...prefs,
      schedulerRefreshedVersion: installedVersion,
      lastSchedulerRefreshAttempt: undefined,
    });
    return { outcome: "refreshed" };
  } catch {
    // Reading or writing preferences failed; the next command tries again.
    return { outcome: "not_owed" };
  }
}

/** The command that re-registers the job by hand, for repair hints. */
export function schedulerRepairCommand(job: LaunchdJob): string {
  return job === "daemon"
    ? "sudo swamp update --setup-auto"
    : "swamp update --setup-auto";
}

export function createAutoupdateRefreshDeps(): AutoupdateRefreshDeps {
  const prefsRepo = new UpdatePreferencesFileRepository();
  return {
    os: Deno.build.os,
    readPreferences: () => prefsRepo.read(),
    writePreferences: (preferences) => prefsRepo.write(preferences),
    detectInstalledLaunchdJob: () => detectInstalledLaunchdMode(),
    isRoot: () => isRunningAsRoot(),
    configDirOwned: () => processOwnsConfigDir(),
    refreshScheduler: (job) => new LaunchdScheduler(job).refresh(),
    now: () => new Date(),
  };
}
