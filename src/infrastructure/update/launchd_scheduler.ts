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
import type { UpdateCadence } from "../../domain/update/update_preferences.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import { homeDirectory } from "../persistence/paths.ts";

const LABEL = "club.swamp.autoupdate";

export type LaunchdMode = "agent" | "daemon";

async function sudoUserHome(): Promise<string | null> {
  const sudoUser = Deno.env.get("SUDO_USER");
  if (!sudoUser) return null;

  try {
    const cmd = new Deno.Command("dscl", {
      args: [".", "-read", `/Users/${sudoUser}`, "NFSHomeDirectory"],
      stdout: "piped",
      stderr: "null",
    });
    const result = await cmd.output();
    if (!result.success) return null;
    const output = new TextDecoder().decode(result.stdout).trim();
    const match = output.match(/NFSHomeDirectory:\s*(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function agentPlistPath(): string {
  return join(homeDirectory(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function agentPlistPathForHome(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

function daemonPlistPath(): string {
  return join("/Library", "LaunchDaemons", `${LABEL}.plist`);
}

function plistPathForMode(mode: LaunchdMode): string {
  return mode === "agent" ? agentPlistPath() : daemonPlistPath();
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function autoupdateLogDir(mode: LaunchdMode = "agent"): string {
  if (mode === "daemon") {
    return join("/var", "log", "swamp");
  }
  return join(homeDirectory(), "Library", "Logs", "swamp");
}

export function autoupdateLogPath(mode: LaunchdMode): string {
  return join(autoupdateLogDir(mode), "autoupdate.log");
}

export function buildPlist(
  binaryPath: string,
  cadence: UpdateCadence,
  mode: LaunchdMode = "agent",
): string {
  const interval = cadence === "daily" ? 86400 : 604800;
  const escapedPath = escapeXml(binaryPath);
  const logDir = autoupdateLogDir(mode);
  const stdoutLog = escapeXml(join(logDir, "autoupdate.stdout.log"));
  const stderrLog = escapeXml(join(logDir, "autoupdate.stderr.log"));

  const userNameEntry = mode === "daemon"
    ? `\n  <key>UserName</key>\n  <string>root</string>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapedPath}</string>
    <string>update</string>
    <string>--background</string>
  </array>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>RunAtLoad</key>
  <true/>${userNameEntry}
  <key>StandardOutPath</key>
  <string>${stdoutLog}</string>
  <key>StandardErrorPath</key>
  <string>${stderrLog}</string>
</dict>
</plist>
`;
}

export function cadenceFromInterval(interval: number): UpdateCadence {
  return interval <= 86400 ? "daily" : "weekly";
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

export class LaunchdScheduler implements AutoupdateScheduler {
  readonly mode: LaunchdMode;

  constructor(mode: LaunchdMode = "agent") {
    this.mode = mode;
  }

  async install(binaryPath: string, cadence: UpdateCadence): Promise<void> {
    await this.remove();

    // When switching modes, also remove the other scheduler type.
    // Under sudo, $HOME is /var/root — resolve the original user's
    // home via $SUDO_USER to find their agent plist.
    if (this.mode === "daemon") {
      await this.removeAgentPlistForOriginalUser();
    } else {
      const otherScheduler = new LaunchdScheduler("daemon");
      await otherScheduler.remove();
    }

    const path = plistPathForMode(this.mode);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.mkdir(autoupdateLogDir(this.mode), { recursive: true });
    await atomicWriteTextFile(path, buildPlist(binaryPath, cadence, this.mode));

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

  async remove(): Promise<void> {
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

  async status(): Promise<ScheduleStatus> {
    const path = plistPathForMode(this.mode);
    try {
      const content = await Deno.readTextFile(path);
      const intervalMatch = content.match(
        /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/,
      );
      const interval = intervalMatch ? parseInt(intervalMatch[1], 10) : 86400;
      return {
        installed: true,
        cadence: cadenceFromInterval(interval),
      };
    } catch {
      return { installed: false };
    }
  }

  private async removeAgentPlistForOriginalUser(): Promise<void> {
    const paths: string[] = [];

    // Check the agent path from current $HOME (may be /var/root under sudo)
    try {
      paths.push(agentPlistPath());
    } catch { /* homeDirectory() may throw */ }

    // Also check the original user's home via $SUDO_USER
    const realHome = await sudoUserHome();
    if (realHome) {
      paths.push(agentPlistPathForHome(realHome));
    }

    for (const path of new Set(paths)) {
      try {
        await Deno.stat(path);
      } catch {
        continue;
      }
      const sudoUid = Deno.env.get("SUDO_UID");
      if (sudoUid) {
        const cmd = new Deno.Command("launchctl", {
          args: ["bootout", `gui/${sudoUid}/${LABEL}`],
          stdout: "null",
          stderr: "null",
        });
        await cmd.output();
      }
      await Deno.remove(path).catch(() => {});
    }
  }

  private async launchctlDomain(): Promise<string> {
    if (this.mode === "daemon") {
      return "system";
    }
    const uid = await getUid();
    return `gui/${uid}`;
  }
}

export async function detectInstalledLaunchdMode(): Promise<
  LaunchdMode | null
> {
  try {
    await Deno.stat(daemonPlistPath());
    return "daemon";
  } catch { /* not found */ }

  // Check agent plist at current $HOME
  try {
    await Deno.stat(agentPlistPath());
    return "agent";
  } catch { /* not found */ }

  // Under sudo, $HOME is /var/root — also check the original user's home
  const realHome = await sudoUserHome();
  if (realHome) {
    try {
      await Deno.stat(agentPlistPathForHome(realHome));
      return "agent";
    } catch { /* not found */ }
  }

  return null;
}
