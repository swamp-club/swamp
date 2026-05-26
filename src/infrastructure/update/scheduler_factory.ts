// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { SystemdScheduler } from "./systemd_scheduler.ts";
import { CronScheduler } from "./cron_scheduler.ts";

async function hasSystemctl(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("systemctl", {
      args: ["--user", "--version"],
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
  switch (Deno.build.os) {
    case "darwin":
      return new LaunchdScheduler(options?.launchdMode ?? "agent");
    case "linux":
      if (await hasSystemctl()) {
        return new SystemdScheduler();
      }
      return new CronScheduler();
    default:
      throw new UserError(
        `Background autoupdate is not yet supported on ${Deno.build.os}`,
      );
  }
}

export async function resolveLaunchdMode(): Promise<LaunchdMode> {
  if (Deno.build.os !== "darwin") return "agent";

  const installed = await detectInstalledLaunchdMode();
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
        `  sudo chown $(whoami) ${Deno.execPath()}\n` +
        `  sudo chown root ${Deno.execPath()}`,
    );
  }
  return result;
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
