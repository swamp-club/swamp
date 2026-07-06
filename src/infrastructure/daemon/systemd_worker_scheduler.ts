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
import type { WorkerDaemonConfig } from "../../domain/worker/worker_daemon_config.ts";
import type {
  WorkerDaemonScheduler,
  WorkerDaemonStatus,
} from "../../domain/worker/worker_daemon_scheduler.ts";
import { UserError } from "../../domain/errors.ts";
import type { LaunchdMode } from "../update/launchd_scheduler.ts";
import {
  escapeSystemdPath,
  systemdUnitDir,
} from "../update/systemd_scheduler.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

const UNIT_NAME = "swamp-worker";

function servicePath(mode: LaunchdMode = "agent"): string {
  return join(systemdUnitDir(mode), `${UNIT_NAME}.service`);
}

export function buildWorkerService(
  config: WorkerDaemonConfig,
  mode: LaunchdMode = "agent",
): string {
  const escapedBinary = escapeSystemdPath(config.binaryPath);

  const args = [
    `"${escapedBinary}"`,
    "worker",
    "connect",
  ];

  if (config.extraArgs) {
    for (const arg of config.extraArgs) {
      args.push(`"${escapeSystemdPath(arg)}"`);
    }
  }

  const envLines: string[] = [];
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      envLines.push(
        `Environment="${escapeSystemdPath(k)}=${escapeSystemdPath(v)}"`,
      );
    }
  }
  const envBlock = envLines.length > 0 ? "\n" + envLines.join("\n") : "";

  const workingDirLine = config.cacheDir
    ? `\nWorkingDirectory=${escapeSystemdPath(config.cacheDir)}`
    : "";

  return `[Unit]
Description=Swamp worker daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args.join(" ")}
KillSignal=SIGTERM
TimeoutStopSec=300
Restart=on-failure
RestartSec=10${workingDirLine}${envBlock}

[Install]
WantedBy=${mode === "daemon" ? "multi-user.target" : "default.target"}
`;
}

async function systemctl(
  mode: LaunchdMode,
  ...args: string[]
): Promise<{ success: boolean; stdout: string }> {
  const modeArgs = mode === "agent" ? ["--user"] : [];
  const cmd = new Deno.Command("systemctl", {
    args: [...modeArgs, ...args],
    stdout: "piped",
    stderr: "null",
  });
  const result = await cmd.output();
  return {
    success: result.success,
    stdout: new TextDecoder().decode(result.stdout).trim(),
  };
}

export class SystemdWorkerScheduler implements WorkerDaemonScheduler {
  readonly mode: LaunchdMode;

  constructor(mode: LaunchdMode = "agent") {
    this.mode = mode;
  }

  async enable(config: WorkerDaemonConfig): Promise<void> {
    await this.disable();

    try {
      const dir = systemdUnitDir(this.mode);
      await Deno.mkdir(dir, { recursive: true });

      await atomicWriteTextFile(
        servicePath(this.mode),
        buildWorkerService(config, this.mode),
        { mode: 0o600 },
      );
    } catch (err: unknown) {
      if (err instanceof Deno.errors.PermissionDenied) {
        const dir = systemdUnitDir(this.mode);
        throw new UserError(
          `Permission denied writing to ${dir}.\n\n` +
            `  Option 1: Run with sudo for a system-wide service\n` +
            `  Option 2: Use --user to install as a per-user service`,
        );
      }
      throw err;
    }

    await systemctl(this.mode, "daemon-reload");
    const result = await systemctl(
      this.mode,
      "enable",
      "--now",
      `${UNIT_NAME}.service`,
    );
    if (!result.success) {
      throw new Error(
        `Failed to enable systemd service ${UNIT_NAME}.service`,
      );
    }
  }

  async disable(): Promise<void> {
    await systemctl(this.mode, "disable", "--now", `${UNIT_NAME}.service`);
    await systemctl(this.mode, "daemon-reload");

    await Deno.remove(servicePath(this.mode)).catch(() => {});
  }

  async status(): Promise<WorkerDaemonStatus> {
    try {
      await Deno.stat(servicePath(this.mode));
    } catch {
      return { enabled: false, running: false };
    }

    const isActive = await systemctl(
      this.mode,
      "is-active",
      `${UNIT_NAME}.service`,
    );
    const running = isActive.stdout === "active";

    let pid: number | undefined;
    const showPid = await systemctl(
      this.mode,
      "show",
      "--property=MainPID",
      `${UNIT_NAME}.service`,
    );
    const pidMatch = showPid.stdout.match(/MainPID=(\d+)/);
    if (pidMatch) {
      const parsed = parseInt(pidMatch[1], 10);
      if (parsed > 0) {
        pid = parsed;
      }
    }

    const logHint = this.mode === "agent"
      ? `journalctl --user -u ${UNIT_NAME}`
      : `journalctl -u ${UNIT_NAME}`;

    return {
      enabled: true,
      running,
      pid,
      logPath: logHint,
    };
  }
}
