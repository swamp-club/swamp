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
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import { homeDirectory } from "../persistence/paths.ts";

const LABEL = "club.swamp.autoupdate";

export type LaunchdMode = "agent" | "daemon";

function agentPlistPath(): string {
  return join(homeDirectory(), "Library", "LaunchAgents", `${LABEL}.plist`);
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

    // When switching modes, also remove the other scheduler type
    const otherMode: LaunchdMode = this.mode === "agent" ? "daemon" : "agent";
    const otherScheduler = new LaunchdScheduler(otherMode);
    await otherScheduler.remove();

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

  try {
    await Deno.stat(agentPlistPath());
    return "agent";
  } catch { /* not found */ }

  return null;
}
