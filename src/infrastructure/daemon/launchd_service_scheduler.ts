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
import type { ServiceConfig } from "../../domain/serve/service_config.ts";
import type {
  ServiceScheduler,
  ServiceStatus,
} from "../../domain/serve/service_scheduler.ts";
import type { LaunchdMode } from "../update/launchd_scheduler.ts";
import { escapeXml } from "../update/launchd_scheduler.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import { homeDirectory } from "../persistence/paths.ts";

const LABEL = "club.swamp.serve";

function agentPlistPath(): string {
  return join(homeDirectory(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function daemonPlistPath(): string {
  return join("/Library", "LaunchDaemons", `${LABEL}.plist`);
}

function plistPathForMode(mode: LaunchdMode): string {
  return mode === "agent" ? agentPlistPath() : daemonPlistPath();
}

export function serveLogDir(mode: LaunchdMode = "agent"): string {
  if (mode === "daemon") {
    return join("/var", "log", "swamp");
  }
  return join(homeDirectory(), "Library", "Logs", "swamp");
}

export function buildServePlist(
  config: ServiceConfig,
  mode: LaunchdMode = "agent",
): string {
  const escapedBinary = escapeXml(config.binaryPath);
  const logDir = serveLogDir(mode);
  const stdoutLog = escapeXml(join(logDir, "serve.stdout.log"));
  const stderrLog = escapeXml(join(logDir, "serve.stderr.log"));
  const escapedRepoDir = escapeXml(config.repoDir);

  const userNameEntry = mode === "daemon"
    ? `\n  <key>UserName</key>\n  <string>root</string>`
    : "";

  const args = [
    `    <string>${escapedBinary}</string>`,
    `    <string>serve</string>`,
    `    <string>--repo-dir</string>`,
    `    <string>${escapedRepoDir}</string>`,
    `    <string>--port</string>`,
    `    <string>${config.port}</string>`,
    `    <string>--host</string>`,
    `    <string>${escapeXml(config.host)}</string>`,
  ];

  if (config.certFile) {
    args.push(`    <string>--cert-file</string>`);
    args.push(`    <string>${escapeXml(config.certFile)}</string>`);
  }
  if (config.keyFile) {
    args.push(`    <string>--key-file</string>`);
    args.push(`    <string>${escapeXml(config.keyFile)}</string>`);
  }
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
  <key>WorkingDirectory</key>
  <string>${escapedRepoDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>${userNameEntry}${envBlock}
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

export class LaunchdServiceScheduler implements ServiceScheduler {
  readonly mode: LaunchdMode;

  constructor(mode: LaunchdMode = "agent") {
    this.mode = mode;
  }

  async enable(config: ServiceConfig): Promise<void> {
    await this.disable();

    const path = plistPathForMode(this.mode);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.mkdir(serveLogDir(this.mode), { recursive: true });
    await atomicWriteTextFile(path, buildServePlist(config, this.mode), {
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

  async status(): Promise<ServiceStatus> {
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
      logPath: serveLogDir(this.mode),
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
