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
import {
  SERVE_SERVICE,
  type ServiceConfig,
  type ServiceIdentity,
} from "../../domain/serve/service_config.ts";
import type {
  ServiceScheduler,
  ServiceStatus,
} from "../../domain/serve/service_scheduler.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import type { LaunchdMode } from "../update/launchd_scheduler.ts";
import {
  escapeSystemdPath,
  systemdUnitDir,
} from "../update/systemd_scheduler.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

function servicePath(
  mode: LaunchdMode = "agent",
  identity: ServiceIdentity = SERVE_SERVICE,
): string {
  return join(systemdUnitDir(mode), `${identity.unitName}.service`);
}

export function buildServeService(
  config: ServiceConfig,
  mode: LaunchdMode = "agent",
  identity: ServiceIdentity = SERVE_SERVICE,
): string {
  const escapedBinary = escapeSystemdPath(config.binaryPath);
  const escapedRepoDir = escapeSystemdPath(config.repoDir);

  const args = config.argv
    ? [
      `"${escapedBinary}"`,
      ...config.argv.map((arg) => `"${escapeSystemdPath(arg)}"`),
    ]
    : [
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
Description=${identity.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args.join(" ")}
ExecReload=/bin/kill -HUP $MAINPID
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
  readonly identity: ServiceIdentity;

  constructor(
    mode: LaunchdMode = "agent",
    identity: ServiceIdentity = SERVE_SERVICE,
  ) {
    this.mode = mode;
    this.identity = identity;
  }

  async enable(config: ServiceConfig): Promise<void> {
    await this.disable();

    try {
      const dir = systemdUnitDir(this.mode);
      await Deno.mkdir(dir, { recursive: true });

      await atomicWriteTextFile(
        servicePath(this.mode, this.identity),
        buildServeService(config, this.mode, this.identity),
        { mode: 0o600 },
      );
    } catch (err: unknown) {
      if (err instanceof Deno.errors.PermissionDenied) {
        const dir = systemdUnitDir(this.mode);
        const hint = this.mode === "agent"
          ? `  Check permissions on ${dir} and its parent directories`
          : `  Option 1: Run with sudo for a system-wide service\n` +
            `  Option 2: Use --user to install as a per-user service`;
        throw markErrorPaths(
          new UserError(
            `Permission denied writing to ${dir}.\n\n${hint}`,
          ),
          [dir],
        );
      }
      throw err;
    }

    await systemctl(this.mode, "daemon-reload");
    const result = await systemctl(
      this.mode,
      "enable",
      "--now",
      `${this.identity.unitName}.service`,
    );
    if (!result.success) {
      throw new Error(
        `Failed to enable systemd service ${this.identity.unitName}.service`,
      );
    }
  }

  async disable(): Promise<void> {
    await systemctl(
      this.mode,
      "disable",
      "--now",
      `${this.identity.unitName}.service`,
    );
    await systemctl(this.mode, "daemon-reload");

    await Deno.remove(servicePath(this.mode, this.identity)).catch(() => {});
  }

  async status(): Promise<ServiceStatus> {
    try {
      await Deno.stat(servicePath(this.mode, this.identity));
    } catch {
      return { enabled: false, running: false };
    }

    const isActive = await systemctl(
      this.mode,
      "is-active",
      `${this.identity.unitName}.service`,
    );
    const running = isActive.stdout === "active";

    let pid: number | undefined;
    const showPid = await systemctl(
      this.mode,
      "show",
      "--property=MainPID",
      `${this.identity.unitName}.service`,
    );
    const pidMatch = showPid.stdout.match(/MainPID=(\d+)/);
    if (pidMatch) {
      const parsed = parseInt(pidMatch[1], 10);
      if (parsed > 0) {
        pid = parsed;
      }
    }

    const logHint = this.mode === "agent"
      ? `journalctl --user -u ${this.identity.unitName}`
      : `journalctl -u ${this.identity.unitName}`;

    return {
      enabled: true,
      running,
      pid,
      logPath: logHint,
    };
  }
}
