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
import type { ServiceConfig } from "../../domain/serve/service_config.ts";
import type {
  ServiceScheduler,
  ServiceStatus,
} from "../../domain/serve/service_scheduler.ts";
import type { LaunchdMode } from "../update/launchd_scheduler.ts";
import {
  escapeSystemdPath,
  systemdUnitDir,
} from "../update/systemd_scheduler.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

const UNIT_NAME = "swamp-serve";

function servicePath(mode: LaunchdMode = "agent"): string {
  return join(systemdUnitDir(mode), `${UNIT_NAME}.service`);
}

export function buildServeService(
  config: ServiceConfig,
  mode: LaunchdMode = "agent",
): string {
  const escapedBinary = escapeSystemdPath(config.binaryPath);
  const escapedRepoDir = escapeSystemdPath(config.repoDir);

  const args = [
    `"${escapedBinary}"`,
    "serve",
    "--repo-dir",
    `"${escapedRepoDir}"`,
    "--port",
    String(config.port),
    "--host",
    `"${escapeSystemdPath(config.host)}"`,
  ];

  if (config.certFile) {
    args.push("--cert-file", `"${escapeSystemdPath(config.certFile)}"`);
  }
  if (config.keyFile) {
    args.push("--key-file", `"${escapeSystemdPath(config.keyFile)}"`);
  }
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

  return `[Unit]
Description=Swamp serve daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args.join(" ")}
WorkingDirectory=${escapedRepoDir}
Restart=always
RestartSec=10${envBlock}

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

export class SystemdServiceScheduler implements ServiceScheduler {
  readonly mode: LaunchdMode;

  constructor(mode: LaunchdMode = "agent") {
    this.mode = mode;
  }

  async enable(config: ServiceConfig): Promise<void> {
    await this.disable();

    const dir = systemdUnitDir(this.mode);
    await Deno.mkdir(dir, { recursive: true });

    await atomicWriteTextFile(
      servicePath(this.mode),
      buildServeService(config, this.mode),
      { mode: 0o600 },
    );

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

  async status(): Promise<ServiceStatus> {
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
