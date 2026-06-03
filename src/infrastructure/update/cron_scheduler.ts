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

import { dirname, join } from "@std/path";
import type {
  AutoupdateScheduler,
  ScheduleStatus,
} from "../../domain/update/autoupdate_scheduler.ts";
import type { LaunchdMode } from "./launchd_scheduler.ts";
import type { UpdateCadence } from "../../domain/update/update_preferences.ts";
import { getSwampDataDir } from "../persistence/paths.ts";

const CRON_MARKER = "# swamp-autoupdate";

export function cronSchedule(cadence: UpdateCadence): string {
  return cadence === "daily" ? "0 9 * * *" : "0 9 * * 1";
}

export function cadenceFromSchedule(schedule: string): UpdateCadence {
  return schedule.trim().endsWith("* * 1") ? "weekly" : "daily";
}

export function escapeShellPath(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function crontabCommand(
  mode: LaunchdMode,
  args: string[],
): { command: string; args: string[] } {
  if (mode === "daemon") {
    return { command: "sudo", args: ["-n", "crontab", ...args] };
  }
  return { command: "crontab", args };
}

function crontabCommandForUser(
  user: string,
  args: string[],
): { command: string; args: string[] } {
  return { command: "sudo", args: ["-n", "-u", user, "crontab", ...args] };
}

async function readCrontab(mode: LaunchdMode = "agent"): Promise<string> {
  const { command, args } = crontabCommand(mode, ["-l"]);
  const cmd = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "null",
  });
  const result = await cmd.output();
  if (!result.success) return "";
  return new TextDecoder().decode(result.stdout);
}

async function readCrontabForUser(user: string): Promise<string> {
  const { command, args } = crontabCommandForUser(user, ["-l"]);
  const cmd = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "null",
  });
  const result = await cmd.output();
  if (!result.success) return "";
  return new TextDecoder().decode(result.stdout);
}

async function writeCrontab(
  content: string,
  mode: LaunchdMode = "agent",
): Promise<void> {
  const { command, args } = crontabCommand(mode, ["-"]);
  const cmd = new Deno.Command(command, {
    args,
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  });
  const process = cmd.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(content));
  await writer.close();
  const status = await process.status;
  if (!status.success) {
    throw new Error(`crontab write failed with exit code ${status.code}`);
  }
}

async function writeCrontabForUser(
  content: string,
  user: string,
): Promise<void> {
  const { command, args } = crontabCommandForUser(user, ["-"]);
  const cmd = new Deno.Command(command, {
    args,
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  });
  const process = cmd.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(content));
  await writer.close();
  const status = await process.status;
  if (!status.success) {
    throw new Error(`crontab write failed with exit code ${status.code}`);
  }
}

export function cronLogPath(mode: LaunchdMode = "agent"): string {
  if (mode === "daemon") {
    return join("/var", "log", "swamp", "autoupdate-cron.log");
  }
  return join(getSwampDataDir(), "log", "autoupdate-cron.log");
}

export class CronScheduler implements AutoupdateScheduler {
  readonly mode: LaunchdMode;

  constructor(mode: LaunchdMode = "agent") {
    this.mode = mode;
  }

  async install(binaryPath: string, cadence: UpdateCadence): Promise<void> {
    await this.remove();

    if (this.mode === "daemon") {
      await this.removeUserCrontabEntry();
    } else {
      const otherScheduler = new CronScheduler("daemon");
      await otherScheduler.remove();
    }

    const logDir = dirname(cronLogPath(this.mode));
    await Deno.mkdir(logDir, { recursive: true });

    const existing = await readCrontab(this.mode);
    const schedule = cronSchedule(cadence);
    const escaped = escapeShellPath(binaryPath);
    const logPath = escapeShellPath(cronLogPath(this.mode));
    const line =
      `${schedule} '${escaped}' update --background > '${logPath}' 2>&1 ${CRON_MARKER}`;
    const newContent = existing.trimEnd() + (existing.trim() ? "\n" : "") +
      line + "\n";
    await writeCrontab(newContent, this.mode);
  }

  async remove(): Promise<void> {
    const existing = await readCrontab(this.mode);
    if (!existing.includes(CRON_MARKER)) return;

    const filtered = existing
      .split("\n")
      .filter((line) => !line.includes(CRON_MARKER))
      .join("\n");
    await writeCrontab(filtered, this.mode);
  }

  async status(): Promise<ScheduleStatus> {
    const crontab = await readCrontab(this.mode);
    const line = crontab
      .split("\n")
      .find((l) => l.includes(CRON_MARKER));

    if (!line) return { installed: false };

    const schedule = line.substring(0, line.indexOf(CRON_MARKER)).trim();
    const parts = schedule.split(/\s+/);
    const cronExpr = parts.slice(0, 5).join(" ");

    return {
      installed: true,
      cadence: cadenceFromSchedule(cronExpr),
    };
  }

  private async removeUserCrontabEntry(): Promise<void> {
    const sudoUser = Deno.env.get("SUDO_USER");
    if (!sudoUser) return;

    const existing = await readCrontabForUser(sudoUser);
    if (!existing.includes(CRON_MARKER)) return;

    const filtered = existing
      .split("\n")
      .filter((line) => !line.includes(CRON_MARKER))
      .join("\n");
    await writeCrontabForUser(filtered, sudoUser);
  }
}

export async function detectInstalledCronMode(): Promise<LaunchdMode | null> {
  const rootCrontab = await readCrontab("daemon");
  if (rootCrontab.includes(CRON_MARKER)) return "daemon";

  const userCrontab = await readCrontab("agent");
  if (userCrontab.includes(CRON_MARKER)) return "agent";

  return null;
}
