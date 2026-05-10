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

import { dirname, join } from "@std/path";
import type {
  AutoupdateScheduler,
  ScheduleStatus,
} from "../../domain/update/autoupdate_scheduler.ts";
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

async function readCrontab(): Promise<string> {
  const cmd = new Deno.Command("crontab", {
    args: ["-l"],
    stdout: "piped",
    stderr: "null",
  });
  const result = await cmd.output();
  if (!result.success) return "";
  return new TextDecoder().decode(result.stdout);
}

async function writeCrontab(content: string): Promise<void> {
  const cmd = new Deno.Command("crontab", {
    args: ["-"],
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

export function cronLogPath(): string {
  return join(getSwampDataDir(), "log", "autoupdate-cron.log");
}

export class CronScheduler implements AutoupdateScheduler {
  async install(binaryPath: string, cadence: UpdateCadence): Promise<void> {
    await this.remove();

    await Deno.mkdir(dirname(cronLogPath()), { recursive: true });

    const existing = await readCrontab();
    const schedule = cronSchedule(cadence);
    const escaped = escapeShellPath(binaryPath);
    const logPath = escapeShellPath(cronLogPath());
    const line =
      `${schedule} '${escaped}' update --background > '${logPath}' 2>&1 ${CRON_MARKER}`;
    const newContent = existing.trimEnd() + (existing.trim() ? "\n" : "") +
      line + "\n";
    await writeCrontab(newContent);
  }

  async remove(): Promise<void> {
    const existing = await readCrontab();
    if (!existing.includes(CRON_MARKER)) return;

    const filtered = existing
      .split("\n")
      .filter((line) => !line.includes(CRON_MARKER))
      .join("\n");
    await writeCrontab(filtered);
  }

  async status(): Promise<ScheduleStatus> {
    const crontab = await readCrontab();
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
}
