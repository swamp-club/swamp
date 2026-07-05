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
import type { WorkerDaemonConfig } from "../../domain/worker/worker_daemon_config.ts";
import type {
  WorkerDaemonScheduler,
  WorkerDaemonStatus,
} from "../../domain/worker/worker_daemon_scheduler.ts";
import type { LaunchdMode } from "../update/launchd_scheduler.ts";
import { escapeXml } from "../update/launchd_scheduler.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import { homeDirectory } from "../persistence/paths.ts";

const LABEL = "club.swamp.worker";

function agentPlistPath(): string {
  return join(homeDirectory(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function daemonPlistPath(): string {
  return join("/Library", "LaunchDaemons", `${LABEL}.plist`);
}

function plistPathForMode(mode: LaunchdMode): string {
  return mode === "agent" ? agentPlistPath() : daemonPlistPath();
}

export function workerLogDir(mode: LaunchdMode = "agent"): string {
  if (mode === "daemon") {
    return join("/var", "log", "swamp");
  }
  return join(homeDirectory(), "Library", "Logs", "swamp");
}

export function buildWorkerPlist(
  config: WorkerDaemonConfig,
  mode: LaunchdMode = "agent",
): string {
  const escapedBinary = escapeXml(config.binaryPath);
  const logDir = workerLogDir(mode);
  const stdoutLog = escapeXml(join(logDir, "worker.stdout.log"));
  const stderrLog = escapeXml(join(logDir, "worker.stderr.log"));

  const userNameEntry = mode === "daemon"
    ? `\n  <key>UserName</key>\n  <string>root</string>`
    : "";

  const args = [
    `    <string>${escapedBinary}</string>`,
    `    <string>worker</string>`,
    `    <string>connect</string>`,
  ];

  if (config.extraArgs) {
    for (const arg of config.extraArgs) {
      args.push(`    <string>${escapeXml(arg)}</string>`);
    }
  }

  let envBlock = "";
  if (config.env && Object.keys(config.env).length > 0) {
    const entries = Object.entries(config.env)
      .map(
        ([k, v]) =>
          `    <key>${escapeXml(k)}</key>\n    <string>${
            escapeXml(v)
          }</string>`,
      )
      .join("\n");
    envBlock =
      `\n  <key>EnvironmentVariables</key>\n  <dict>\n${entries}\n  </dict>`;
  }

  const workingDirBlock = config.cacheDir
    ? `\n  <key>WorkingDirectory</key>\n  <string>${
      escapeXml(config.cacheDir)
    }</string>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>${workingDirBlock}${userNameEntry}${envBlock}
  <key>StandardOutPath</key>
  <string>${stdoutLog}</string>
  <key>StandardErrorPath</key>
  <string>${stderrLog}</string>
</dict>
</plist>
`;
}

async function getUid(): Promise<string> {
  const cmd = new Deno.Command("id", {
    args: ["-u"],
    stdout: "piped",
    stderr: "null",
  });
  const result = await cmd.output();
  return new TextDecoder().decode(result.stdout).trim();
}

export class LaunchdWorkerScheduler implements WorkerDaemonScheduler {
  readonly mode: LaunchdMode;

  constructor(mode: LaunchdMode = "agent") {
    this.mode = mode;
  }

  async enable(config: WorkerDaemonConfig): Promise<void> {
    await this.disable();

    const path = plistPathForMode(this.mode);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.mkdir(workerLogDir(this.mode), { recursive: true });
    await atomicWriteTextFile(path, buildWorkerPlist(config, this.mode), {
      mode: 0o600,
    });

    const domain = await this.launchctlDomain();
    const cmd = new Deno.Command("launchctl", {
      args: ["bootstrap", domain, path],
      stdout: "null",
      stderr: "null",
    });
    const result = await cmd.output();
    if (!result.success) {
      throw new Error(
        `launchctl bootstrap failed with exit code ${result.code}`,
      );
    }
  }

  async disable(): Promise<void> {
    const path = plistPathForMode(this.mode);
    try {
      await Deno.stat(path);
    } catch {
      return;
    }

    const domain = await this.launchctlDomain();
    const cmd = new Deno.Command("launchctl", {
      args: ["bootout", `${domain}/${LABEL}`],
      stdout: "null",
      stderr: "null",
    });
    await cmd.output();

    await Deno.remove(path).catch(() => {});
  }

  async status(): Promise<WorkerDaemonStatus> {
    const path = plistPathForMode(this.mode);
    try {
      await Deno.stat(path);
    } catch {
      return { enabled: false, running: false };
    }

    const domain = await this.launchctlDomain();
    const cmd = new Deno.Command("launchctl", {
      args: ["print", `${domain}/${LABEL}`],
      stdout: "piped",
      stderr: "null",
    });
    const result = await cmd.output();
    const output = new TextDecoder().decode(result.stdout);

    const running = result.success;
    let pid: number | undefined;
    const pidMatch = output.match(/pid\s*=\s*(\d+)/);
    if (pidMatch) {
      pid = parseInt(pidMatch[1], 10);
    }

    return {
      enabled: true,
      running,
      pid,
      logPath: workerLogDir(this.mode),
    };
  }

  private async launchctlDomain(): Promise<string> {
    if (this.mode === "daemon") {
      return "system";
    }
    const uid = await getUid();
    return `gui/${uid}`;
  }
}
