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
import type { ScheduleStatus } from "./autoupdate_scheduler.ts";
import type { UpdateCadence } from "./update_preferences.ts";

export type InstallCheckStatus = "pass" | "fail" | "skip";

export interface InstallHealthReport {
  binaryPath: string;
  owner: BinaryOwner;
  currentVersion: string;
  writable: InstallCheckStatus;
  writableMessage: string;
  autoupdate: AutoupdateHealth;
}

export interface BinaryOwner {
  uid: number | null;
  username: string | null;
  isRoot: boolean;
}

export type SchedulerTypeLabel =
  | "agent"
  | "daemon"
  | "systemd-user"
  | "systemd-system"
  | "cron-user"
  | "cron-root";

export interface AutoupdateHealth {
  enabled: boolean;
  cadence: UpdateCadence;
  schedulerInstalled: boolean;
  schedulerType?: SchedulerTypeLabel;
  lastEntry: AutoupdateLogEntry | null;
}

export interface InstallHealthDeps {
  binaryPath: string;
  currentVersion: string;
  statBinary(): Promise<{ uid: number | null }>;
  probeBinaryWritable(): Promise<boolean>;
  getCurrentUid(): number | null;
  getCurrentUsername(): string | null;
  getPreferences(): Promise<{ enabled: boolean; cadence: UpdateCadence }>;
  getSchedulerStatus(): Promise<ScheduleStatus>;
  getSchedulerType?(): Promise<SchedulerTypeLabel | null>;
  getLastLogEntry(): Promise<AutoupdateLogEntry | null>;
}

export async function checkInstallHealth(
  deps: InstallHealthDeps,
): Promise<InstallHealthReport> {
  const stat = await deps.statBinary();

  const currentUid = deps.getCurrentUid();
  const isRoot = stat.uid === 0;
  const ownedByCurrentUser = currentUid !== null && stat.uid === currentUid;

  let writable: InstallCheckStatus;
  let writableMessage: string;

  if (stat.uid === null) {
    const canWrite = await deps.probeBinaryWritable();
    writable = canWrite ? "pass" : "fail";
    writableMessage = canWrite
      ? "Binary is writable by current user"
      : "Binary is not writable by current user";
  } else if (ownedByCurrentUser) {
    writable = "pass";
    writableMessage = "Binary is owned by current user";
  } else if (isRoot) {
    const canWrite = await deps.probeBinaryWritable();
    writable = canWrite ? "pass" : "fail";
    writableMessage = canWrite
      ? "Binary is root-owned but writable (e.g. group/other write)"
      : "Binary is root-owned and not writable by current user";
  } else {
    const canWrite = await deps.probeBinaryWritable();
    writable = canWrite ? "pass" : "fail";
    writableMessage = canWrite
      ? "Binary is writable by current user"
      : `Binary is owned by uid ${stat.uid} and not writable by current user`;
  }

  const prefs = await deps.getPreferences();
  const schedulerStatus = await deps.getSchedulerStatus();
  const schedulerType = deps.getSchedulerType
    ? await deps.getSchedulerType()
    : null;
  const lastEntry = await deps.getLastLogEntry();

  let username: string | null = deps.getCurrentUsername();
  if (stat.uid !== null && stat.uid !== currentUid) {
    username = isRoot ? "root" : `uid:${stat.uid}`;
  }

  return {
    binaryPath: deps.binaryPath,
    owner: {
      uid: stat.uid,
      username,
      isRoot,
    },
    currentVersion: deps.currentVersion,
    writable,
    writableMessage,
    autoupdate: {
      enabled: prefs.enabled,
      cadence: prefs.cadence,
      schedulerInstalled: schedulerStatus.installed,
      schedulerType: schedulerType ?? undefined,
      lastEntry,
    },
  };
}
