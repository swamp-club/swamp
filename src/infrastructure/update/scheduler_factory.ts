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
import { LaunchdScheduler } from "./launchd_scheduler.ts";
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

export async function createScheduler(): Promise<AutoupdateScheduler> {
  switch (Deno.build.os) {
    case "darwin":
      return new LaunchdScheduler();
    case "linux":
      if (await hasSystemctl()) {
        return new SystemdScheduler();
      }
      return new CronScheduler();
    default:
      throw new Error(
        `Background autoupdate is not yet supported on ${Deno.build.os}`,
      );
  }
}
