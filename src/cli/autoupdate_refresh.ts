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

import type {
  SchedulerRefreshOptions,
  SchedulerRefreshResult,
} from "../domain/update/autoupdate_scheduler.ts";
import { shouldRefreshScheduler } from "../domain/update/autoupdate_staleness.ts";
import type { UpdatePreferences } from "../domain/update/update_preferences.ts";
import { join } from "@std/path";
import { processOwnsConfigDir } from "../infrastructure/persistence/config_dir_ownership.ts";
import { getSwampConfigDir } from "../infrastructure/persistence/paths.ts";
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
  refreshScheduler(
    job: LaunchdJob,
    options: SchedulerRefreshOptions,
  ): Promise<SchedulerRefreshResult>;
  /**
   * Runs `fn` while holding the refresh lock, or returns null without
   * running it when another swamp process holds it.
   */
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T | null>;
  now(): Date;
}

export type AutoupdateRefreshOutcome =
  | { outcome: "refreshed" }
  | { outcome: "skipped" }
  | { outcome: "not_owed" }
  | { outcome: "failed"; job: LaunchdJob; error: string };

/**
 * Re-registers the macOS autoupdate job for `installedVersion` when one is
 * owed (see shouldRefreshScheduler). Only one swamp process refreshes at a
 * time, and it re-reads the preferences under the lock, so two commands
 * finishing together never boot out the job the other just started.
 * Records the version when the job was refreshed or needed nothing, and the
 * attempt time on failure or when the job's state cannot be read, so either
 * is retried daily rather than on every command. A running job is left
 * alone and retried by the next command. Never throws.
 */
export async function refreshAutoupdateSchedulerIfOwed(
  deps: AutoupdateRefreshDeps,
  installedVersion: string,
): Promise<AutoupdateRefreshOutcome> {
  if (deps.os !== "darwin") return { outcome: "not_owed" };

  const isOwed = async () => {
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
    return owed && job !== null ? { prefs, job } : null;
  };

  try {
    if (!(await isOwed())) return { outcome: "not_owed" };

    const outcome = await deps.withRefreshLock(
      async (): Promise<AutoupdateRefreshOutcome> => {
        const owed = await isOwed();
        if (!owed) return { outcome: "not_owed" };
        const { prefs, job } = owed;

        let result: SchedulerRefreshResult;
        try {
          // A failed attempt may have left the job unloaded; load it then.
          result = await deps.refreshScheduler(job, {
            loadIfNotLoaded: prefs.lastSchedulerRefreshAttempt !== undefined,
          });
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
        if (result === "unknown") {
          // The state may stay unreadable (a launchctl format change), so
          // wait a day like a failure instead of re-checking every command.
          await deps.writePreferences({
            ...prefs,
            lastSchedulerRefreshAttempt: deps.now().toISOString(),
          });
          return { outcome: "skipped" };
        }
        if (result === "not_installed") return { outcome: "not_owed" };

        await deps.writePreferences({
          ...prefs,
          schedulerRefreshedVersion: installedVersion,
          lastSchedulerRefreshAttempt: undefined,
        });
        return { outcome: result === "refreshed" ? "refreshed" : "not_owed" };
      },
    );
    return outcome ?? { outcome: "skipped" };
  } catch {
    // Reading or writing preferences failed; the next command tries again.
    return { outcome: "not_owed" };
  }
}

const REFRESH_LOCK_FILE = "autoupdate-refresh.lock";
/** A lock older than this was left by a process that died mid-refresh. */
const STALE_REFRESH_LOCK_MS = 2 * 60 * 1000;

async function withLockFile<T>(
  path: string,
  fn: () => Promise<T>,
  retryStale = true,
): Promise<T | null> {
  try {
    const file = await Deno.open(path, { createNew: true, write: true });
    file.close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    const stat = await Deno.stat(path).catch(() => null);
    const age = stat?.mtime ? Date.now() - stat.mtime.getTime() : 0;
    if (retryStale && age > STALE_REFRESH_LOCK_MS) {
      await Deno.remove(path).catch(() => {});
      return await withLockFile(path, fn, false);
    }
    return null;
  }
  try {
    return await fn();
  } finally {
    await Deno.remove(path).catch(() => {});
  }
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
    refreshScheduler: (job, options) =>
      new LaunchdScheduler(job).refresh(options),
    withRefreshLock: async (fn) => {
      const dir = getSwampConfigDir();
      await Deno.mkdir(dir, { recursive: true });
      return await withLockFile(join(dir, REFRESH_LOCK_FILE), fn);
    },
    now: () => new Date(),
  };
}
