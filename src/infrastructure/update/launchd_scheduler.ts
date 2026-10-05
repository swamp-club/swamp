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
import {
  type AutoupdateScheduler,
  SCHEDULER_EX_CONFIG,
  SchedulerRefreshError,
  type SchedulerRefreshOptions,
  type SchedulerRefreshResult,
  type SchedulerRuntime,
  type ScheduleStatus,
} from "../../domain/update/autoupdate_scheduler.ts";
import type { UpdateCadence } from "../../domain/update/update_preferences.ts";
import { markErrorPaths } from "../../domain/errors.ts";
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

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Reverses {@link escapeXml}; a single pass so `&amp;lt;` stays `&lt;`. */
export function unescapeXml(s: string): string {
  return s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, name: string) => XML_ENTITIES[name],
  );
}

/**
 * Reads the binary path and interval back out of a plist written by
 * {@link buildPlist}. Returns null when the plist does not have that shape.
 */
export function parsePlistJob(
  content: string,
): { binaryPath: string; interval: number } | null {
  const program = content.match(
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/,
  );
  const interval = content.match(
    /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/,
  );
  if (!program || !interval) return null;
  return {
    binaryPath: unescapeXml(program[1]),
    interval: parseInt(interval[1], 10),
  };
}

/**
 * Parses the job-level fields of `launchctl print <domain>/<label>`. The
 * format is undocumented, so anything unrecognised reads as null (unknown)
 * rather than as a problem. Only lines indented by a single tab belong to
 * the job itself; nested blocks repeat keys like `state`.
 *
 * `has LWCR` in the properties means launchd holds a lightweight code
 * requirement for the job's executable — for an ad-hoc signed binary, its
 * exact cdhash, so a replaced binary will be refused. With `has LWCR`,
 * `needs LWCR update` means it already has been: the state an ad-hoc signed
 * binary is left in after it replaces itself. Without it, the job was just
 * registered again and launchd will compute a fresh requirement from the
 * binary on disk at its next launch.
 */
export function parseLaunchctlPrint(text: string): SchedulerRuntime | null {
  const state = text.match(/^\tstate = (.+)$/m);
  if (!state) return null;

  let lastExitCode: number | null = null;
  const exit = text.match(/^\tlast exit code = (-?\d+)/m);
  if (exit) lastExitCode = parseInt(exit[1], 10);

  const properties = (text.match(/^\tproperties = (.+)$/m)?.[1] ?? "")
    .split("|")
    .map((p) => p.trim());

  const pinnedToBinary = properties.includes("has LWCR");
  return {
    running: state[1].trim() === "running",
    lastExitCode,
    // `needs LWCR update` alone is the normal state of a freshly registered
    // job awaiting its first launch; it is only stuck while launchd still
    // holds the old requirement, or once it has refused a launch.
    needsRepair: lastExitCode === SCHEDULER_EX_CONFIG ||
      (pinnedToBinary && properties.includes("needs LWCR update")),
    pinnedToBinary,
  };
}

/** How long refresh() waits for launchd to finish booting the job out. */
const BOOTOUT_POLL_ATTEMPTS = 20;
const BOOTOUT_POLL_INTERVAL_MS = 250;

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
  const interval = cadence === "hourly"
    ? 3600
    : cadence === "daily"
    ? 86400
    : 604800;
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
  return interval <= 3600 ? "hourly" : interval <= 86400 ? "daily" : "weekly";
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

async function launchctl(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Deno.Command("launchctl", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

export class LaunchdScheduler implements AutoupdateScheduler {
  readonly mode: LaunchdMode;
  private readonly bootoutPollIntervalMs: number;

  constructor(
    mode: LaunchdMode = "agent",
    options: { bootoutPollIntervalMs?: number } = {},
  ) {
    this.mode = mode;
    this.bootoutPollIntervalMs = options.bootoutPollIntervalMs ??
      BOOTOUT_POLL_INTERVAL_MS;
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
    let content: string;
    try {
      content = await Deno.readTextFile(path);
    } catch {
      return { installed: false };
    }
    const intervalMatch = content.match(
      /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/,
    );
    const interval = intervalMatch ? parseInt(intervalMatch[1], 10) : 86400;
    const runtime = await this.runtime();
    return {
      installed: true,
      cadence: cadenceFromInterval(interval),
      ...(runtime ? { runtime } : {}),
    };
  }

  /**
   * Registers the job with launchd again (bootout, then bootstrap), keeping
   * the binary path and interval it already has. launchd can pin a job to
   * the code signature of the binary it last started; swamp's binaries are
   * ad-hoc signed, so after an update launchd refuses to start the new one
   * (exit 78, `EX_CONFIG`) until the job is registered again. The plist is
   * rewritten first so Background Task Management sees a changed item.
   *
   * Leaves the job alone when it is running (a scheduled update may be
   * mid-way through writing its log entry), when its state cannot be read
   * (`unknown`, which includes a launchd domain that does not exist, as over
   * SSH with nobody logged in to the desktop), and when it is healthy and
   * not pinned to a binary, or not loaded at all (unless `loadIfNotLoaded`).
   */
  async refresh(
    options: SchedulerRefreshOptions = {},
  ): Promise<SchedulerRefreshResult> {
    const path = plistPathForMode(this.mode);
    let content: string;
    try {
      content = await Deno.readTextFile(path);
    } catch {
      return "not_installed";
    }
    const job = parsePlistJob(content);
    if (!job) {
      throw markErrorPaths(
        new Error(`Cannot read the autoupdate job from ${path}`),
        [path],
      );
    }

    const domain = await this.launchctlDomain();
    const target = `${domain}/${LABEL}`;
    const printed = await launchctl(["print", target]);
    if (printed.code !== 0) {
      // No domain at all, as over SSH with nobody logged in to the desktop,
      // reads as unknown. A domain without the job means it is not loaded —
      // for example turned off in Login Items — so launchd holds no stale
      // requirement for it and there is nothing to repair.
      // An earlier failed refresh may have booted the job out without
      // loading it again, so that case loads it.
      if ((await launchctl(["print", domain])).code !== 0) return "unknown";
      if (!options.loadIfNotLoaded) return "not_needed";
      return await this.bootstrap(domain, path, true);
    }
    const runtime = parseLaunchctlPrint(printed.stdout);
    if (!runtime) return "unknown";
    if (runtime.running) return "skipped";
    const healthy = !runtime.pinnedToBinary && !runtime.needsRepair &&
      (runtime.lastExitCode === null || runtime.lastExitCode === 0);
    if (healthy) return "not_needed";

    await atomicWriteTextFile(
      path,
      buildPlist(job.binaryPath, cadenceFromInterval(job.interval), this.mode),
    );

    await launchctl(["bootout", target]);
    let unloaded = false;
    for (let i = 0; i < BOOTOUT_POLL_ATTEMPTS; i++) {
      if ((await launchctl(["print", target])).code !== 0) {
        unloaded = true;
        break;
      }
      await new Promise((r) => setTimeout(r, this.bootoutPollIntervalMs));
    }
    if (!unloaded) {
      throw new Error(
        `launchctl bootout did not unload ${target}; the job was left as it was`,
      );
    }

    return await this.bootstrap(domain, path, true);
  }

  /** Loads the job, trying a second time before reporting launchd's reason. */
  private async bootstrap(
    domain: string,
    path: string,
    leftUnloadedOnFailure: boolean,
  ): Promise<SchedulerRefreshResult> {
    let result = await launchctl(["bootstrap", domain, path]);
    if (result.code !== 0) {
      result = await launchctl(["bootstrap", domain, path]);
    }
    if (result.code !== 0) {
      const reason = result.stderr.trim();
      throw new SchedulerRefreshError(
        `launchctl bootstrap failed with exit code ${result.code}` +
          (reason ? `: ${reason}` : ""),
        leftUnloadedOnFailure,
      );
    }
    return "refreshed";
  }

  private async runtime(): Promise<SchedulerRuntime | null> {
    try {
      const domain = await this.launchctlDomain();
      const result = await launchctl(["print", `${domain}/${LABEL}`]);
      if (result.code !== 0) return null;
      return parseLaunchctlPrint(result.stdout);
    } catch {
      return null;
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
