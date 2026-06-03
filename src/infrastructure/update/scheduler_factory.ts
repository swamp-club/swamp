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

import type { AutoupdateScheduler } from "../../domain/update/autoupdate_scheduler.ts";
import { UserError } from "../../domain/errors.ts";
import {
  detectInstalledLaunchdMode,
  type LaunchdMode,
  LaunchdScheduler,
} from "./launchd_scheduler.ts";
import {
  detectInstalledSystemdMode,
  SystemdScheduler,
} from "./systemd_scheduler.ts";
import { CronScheduler, detectInstalledCronMode } from "./cron_scheduler.ts";

async function hasSystemctl(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("systemctl", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    const result = await cmd.output();
    return result.success;
  } catch {
    return false;
  }
}

export interface SchedulerOptions {
  launchdMode?: LaunchdMode;
}

export async function createScheduler(
  options?: SchedulerOptions,
): Promise<AutoupdateScheduler> {
  const mode = options?.launchdMode ?? "agent";
  switch (Deno.build.os) {
    case "darwin":
      return new LaunchdScheduler(mode);
    case "linux":
      if (await hasSystemctl()) {
        return new SystemdScheduler(mode);
      }
      return new CronScheduler(mode);
    default:
      throw new UserError(
        `Background autoupdate is not yet supported on ${Deno.build.os}`,
      );
  }
}

// Resolves scheduler privilege level across all platforms, not just launchd.
// Returns "daemon" when the binary is root-owned (privileged scheduler needed),
// "agent" otherwise (user-level scheduler).
export async function resolveLaunchdMode(): Promise<LaunchdMode> {
  const installed = await detectInstalledMode();
  if (installed) return installed;

  let currentUid: number | null = null;
  let binaryUid: number | null = null;
  try {
    currentUid = Deno.uid();
    const stat = await Deno.stat(Deno.execPath());
    binaryUid = stat.uid;
  } catch {
    return "agent";
  }

  const result = detectBinaryOwnership(binaryUid, currentUid);
  if (result === "foreign") {
    throw new UserError(
      `The swamp binary at ${Deno.execPath()} is owned by uid ${binaryUid}, ` +
        `not the current user or root.\n` +
        `Fix the installation so the binary is owned by your user or root:\n\n` +
        `  Option 1: sudo chown $(whoami) ${Deno.execPath()}\n` +
        `  Option 2: sudo chown root ${Deno.execPath()}`,
    );
  }
  return result;
}

async function detectInstalledMode(): Promise<LaunchdMode | null> {
  switch (Deno.build.os) {
    case "darwin":
      return await detectInstalledLaunchdMode();
    case "linux":
      return await detectInstalledLinuxMode();
    default:
      return null;
  }
}

export async function detectInstalledLinuxMode(): Promise<LaunchdMode | null> {
  const systemd = await detectInstalledSystemdMode();
  if (systemd) return systemd;

  return await detectInstalledCronMode();
}

export function detectBinaryOwnership(
  binaryUid: number | null,
  currentUid: number | null,
): LaunchdMode | "foreign" {
  if (binaryUid === null || currentUid === null) {
    return "agent";
  }
  if (binaryUid === 0) {
    return "daemon";
  }
  if (binaryUid !== currentUid) {
    return "foreign";
  }
  return "agent";
}

export function isRunningAsRoot(): boolean {
  try {
    return Deno.uid() === 0;
  } catch {
    return false;
  }
}
