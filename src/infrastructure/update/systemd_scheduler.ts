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

import { join } from "@std/path";
import type {
  AutoupdateScheduler,
  ScheduleStatus,
} from "../../domain/update/autoupdate_scheduler.ts";
import type { UpdateCadence } from "../../domain/update/update_preferences.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

const UNIT_NAME = "swamp-autoupdate";

function systemdUserDir(): string {
  const xdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
  const home = Deno.env.get("HOME");
  if (!home && !xdgConfigHome) {
    throw new Error("Cannot determine home directory (HOME not set)");
  }
  const base = xdgConfigHome ?? join(home!, ".config");
  return join(base, "systemd", "user");
}

function servicePath(): string {
  return join(systemdUserDir(), `${UNIT_NAME}.service`);
}

function timerPath(): string {
  return join(systemdUserDir(), `${UNIT_NAME}.timer`);
}

export function escapeSystemdPath(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
}

export function buildService(binaryPath: string): string {
  const escaped = escapeSystemdPath(binaryPath);
  return `[Unit]
Description=Swamp background autoupdate

[Service]
Type=oneshot
ExecStart="${escaped}" update --background
`;
}

export function buildTimer(cadence: UpdateCadence): string {
  const onCalendar = cadence === "daily" ? "daily" : "weekly";
  return `[Unit]
Description=Swamp autoupdate timer

[Timer]
OnCalendar=${onCalendar}
Persistent=true
RandomizedDelaySec=3600

[Install]
WantedBy=timers.target
`;
}

async function systemctl(...args: string[]): Promise<boolean> {
  const cmd = new Deno.Command("systemctl", {
    args: ["--user", ...args],
    stdout: "null",
    stderr: "null",
  });
  const result = await cmd.output();
  return result.success;
}

export class SystemdScheduler implements AutoupdateScheduler {
  async install(binaryPath: string, cadence: UpdateCadence): Promise<void> {
    await this.remove();

    const dir = systemdUserDir();
    await Deno.mkdir(dir, { recursive: true });

    await atomicWriteTextFile(servicePath(), buildService(binaryPath));
    await atomicWriteTextFile(timerPath(), buildTimer(cadence));

    await systemctl("daemon-reload");
    const started = await systemctl("enable", "--now", `${UNIT_NAME}.timer`);
    if (!started) {
      throw new Error(
        `Failed to enable systemd timer ${UNIT_NAME}.timer`,
      );
    }
  }

  async remove(): Promise<void> {
    await systemctl("disable", "--now", `${UNIT_NAME}.timer`);
    await systemctl("daemon-reload");

    await Deno.remove(timerPath()).catch(() => {});
    await Deno.remove(servicePath()).catch(() => {});
  }

  async status(): Promise<ScheduleStatus> {
    try {
      const content = await Deno.readTextFile(timerPath());
      const calendarMatch = content.match(/OnCalendar=(\w+)/);
      const cadence: UpdateCadence = calendarMatch?.[1] === "weekly"
        ? "weekly"
        : "daily";

      const cmd = new Deno.Command("systemctl", {
        args: ["--user", "is-active", `${UNIT_NAME}.timer`],
        stdout: "piped",
        stderr: "null",
      });
      const result = await cmd.output();
      const active = new TextDecoder().decode(result.stdout).trim() ===
        "active";

      if (!active) {
        return { installed: false };
      }

      return { installed: true, cadence };
    } catch {
      return { installed: false };
    }
  }
}
