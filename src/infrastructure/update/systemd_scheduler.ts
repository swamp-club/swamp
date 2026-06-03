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

import { join } from "@std/path";
import type {
  AutoupdateScheduler,
  ScheduleStatus,
} from "../../domain/update/autoupdate_scheduler.ts";
import type { LaunchdMode } from "./launchd_scheduler.ts";
import type { UpdateCadence } from "../../domain/update/update_preferences.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

const UNIT_NAME = "swamp-autoupdate";

const SYSTEM_UNIT_DIR = "/etc/systemd/system";

function systemdUserDir(): string {
  const xdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
  const home = Deno.env.get("HOME");
  if (!home && !xdgConfigHome) {
    throw new Error("Cannot determine home directory (HOME not set)");
  }
  const base = xdgConfigHome ?? join(home!, ".config");
  return join(base, "systemd", "user");
}

function systemdUserDirForHome(home: string): string {
  return join(home, ".config", "systemd", "user");
}

export function systemdUnitDir(mode: LaunchdMode): string {
  return mode === "daemon" ? SYSTEM_UNIT_DIR : systemdUserDir();
}

function servicePath(mode: LaunchdMode = "agent"): string {
  return join(systemdUnitDir(mode), `${UNIT_NAME}.service`);
}

function timerPath(mode: LaunchdMode = "agent"): string {
  return join(systemdUnitDir(mode), `${UNIT_NAME}.timer`);
}

async function linuxSudoUserHome(): Promise<string | null> {
  const sudoUser = Deno.env.get("SUDO_USER");
  if (!sudoUser) return null;

  try {
    const cmd = new Deno.Command("getent", {
      args: ["passwd", sudoUser],
      stdout: "piped",
      stderr: "null",
    });
    const result = await cmd.output();
    if (!result.success) return null;
    const output = new TextDecoder().decode(result.stdout).trim();
    const fields = output.split(":");
    return fields.length >= 6 ? fields[5] : null;
  } catch {
    return null;
  }
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

async function systemctl(
  mode: LaunchdMode,
  ...args: string[]
): Promise<boolean> {
  const modeArgs = mode === "agent" ? ["--user"] : [];
  const cmd = new Deno.Command("systemctl", {
    args: [...modeArgs, ...args],
    stdout: "null",
    stderr: "null",
  });
  const result = await cmd.output();
  return result.success;
}

export class SystemdScheduler implements AutoupdateScheduler {
  readonly mode: LaunchdMode;

  constructor(mode: LaunchdMode = "agent") {
    this.mode = mode;
  }

  async install(binaryPath: string, cadence: UpdateCadence): Promise<void> {
    await this.remove();

    if (this.mode === "daemon") {
      await this.removeUserTimerForOriginalUser();
    } else {
      const otherScheduler = new SystemdScheduler("daemon");
      await otherScheduler.remove();
    }

    const dir = systemdUnitDir(this.mode);
    await Deno.mkdir(dir, { recursive: true });

    await atomicWriteTextFile(
      servicePath(this.mode),
      buildService(binaryPath),
    );
    await atomicWriteTextFile(timerPath(this.mode), buildTimer(cadence));

    await systemctl(this.mode, "daemon-reload");
    const started = await systemctl(
      this.mode,
      "enable",
      "--now",
      `${UNIT_NAME}.timer`,
    );
    if (!started) {
      throw new Error(
        `Failed to enable systemd timer ${UNIT_NAME}.timer`,
      );
    }
  }

  async remove(): Promise<void> {
    await systemctl(this.mode, "disable", "--now", `${UNIT_NAME}.timer`);
    await systemctl(this.mode, "daemon-reload");

    await Deno.remove(timerPath(this.mode)).catch(() => {});
    await Deno.remove(servicePath(this.mode)).catch(() => {});
  }

  async status(): Promise<ScheduleStatus> {
    try {
      const content = await Deno.readTextFile(timerPath(this.mode));
      const calendarMatch = content.match(/OnCalendar=(\w+)/);
      const cadence: UpdateCadence = calendarMatch?.[1] === "weekly"
        ? "weekly"
        : "daily";

      const modeArgs = this.mode === "agent" ? ["--user"] : [];
      const cmd = new Deno.Command("systemctl", {
        args: [...modeArgs, "is-active", `${UNIT_NAME}.timer`],
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

  private async removeUserTimerForOriginalUser(): Promise<void> {
    const realHome = await linuxSudoUserHome();
    if (!realHome) return;

    const userDir = systemdUserDirForHome(realHome);
    const userTimerPath = join(userDir, `${UNIT_NAME}.timer`);
    const userServicePath = join(userDir, `${UNIT_NAME}.service`);

    try {
      await Deno.stat(userTimerPath);
    } catch {
      return;
    }

    const sudoUser = Deno.env.get("SUDO_USER");
    const sudoUid = Deno.env.get("SUDO_UID");
    if (sudoUser) {
      // systemctl --user needs XDG_RUNTIME_DIR for the target user's
      // D-Bus session, which is absent under sudo.
      const env: Record<string, string> = {};
      if (sudoUid) {
        env["XDG_RUNTIME_DIR"] = `/run/user/${sudoUid}`;
      }
      const cmd = new Deno.Command("sudo", {
        args: [
          "-u",
          sudoUser,
          "systemctl",
          "--user",
          "disable",
          "--now",
          `${UNIT_NAME}.timer`,
        ],
        env,
        stdout: "null",
        stderr: "null",
      });
      await cmd.output();
    }

    await Deno.remove(userTimerPath).catch(() => {});
    await Deno.remove(userServicePath).catch(() => {});
  }
}

export async function detectInstalledSystemdMode(): Promise<
  LaunchdMode | null
> {
  try {
    await Deno.stat(join(SYSTEM_UNIT_DIR, `${UNIT_NAME}.timer`));
    return "daemon";
  } catch { /* not found */ }

  try {
    await Deno.stat(timerPath("agent"));
    return "agent";
  } catch { /* not found */ }

  return null;
}
