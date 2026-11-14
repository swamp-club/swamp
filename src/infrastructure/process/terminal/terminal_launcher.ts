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
import { ensureDir } from "@std/fs";
import { atomicWriteTextFile } from "../../persistence/atomic_write.ts";
import { refuseSymlinks } from "../../persistence/start_session_file_repository.ts";
import type { HarnessLaunchSpec } from "../../../domain/start/harness.ts";
import {
  copyCommand,
  type LauncherEnvironment,
  renderCmdLauncher,
  renderPosixLauncher,
} from "../../../domain/start/launcher_script.ts";
import type {
  LaunchOutcome,
  NoTerminalReason,
  ProcessInfo,
  TerminalAttempt,
  TerminalAttemptResult,
  TerminalChoice,
  TerminalLauncher,
} from "../../../domain/start/terminal_launcher.ts";
import { orderTerminals } from "../../../domain/start/terminal_choice.ts";
import { createProcessLister } from "./process_list.ts";
import { NESTED_SWAMP_ENV_VARS } from "../../../domain/remote/environment_snapshot.ts";
import { defaultCommandResolver } from "../resolve_command.ts";
import { startDir } from "../../persistence/start_session_file_repository.ts";

/**
 * Variables the launcher re-exports when they were set for `swamp start`:
 * where swamp keeps its files, and which Swamp Club server it talks to, so
 * the agent's swamp uses the same ones. None of them is a secret.
 */
export const LAUNCHER_EXPORTED_VARS = [
  "SWAMP_HOME",
  "SWAMP_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "SWAMP_CLUB_URL",
] as const;

/**
 * the window opens in the workspace so the cmd /k command never contains the
 * workspace path: a folder like R&D or a;b cannot split it, and wt never sees a
 * ; (its separator)
 */
export const WINDOWS_LAUNCHER_RELATIVE_PATH = ".swamp\\start\\launch.cmd";

export const TERMINAL_LAUNCH_GRACE_MS = 1500;

/** present inside podman, toolbox and distrobox containers */
export const CONTAINER_MARKERS = ["/run/.containerenv", "/run/.toolboxenv"];

export interface TerminalProcess {
  readonly status: Promise<{ readonly success: boolean }>;
  unref(): void;
}

export interface TerminalLauncherDeps {
  readonly os: typeof Deno.build.os;
  /** the page is open on another machine, so a window here would go unseen */
  readonly remoteBrowser?: boolean;
  readonly env: (name: string) => string | undefined;
  readonly resolve: (name: string) => Promise<string | null>;
  readonly spawn: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => TerminalProcess;
  readonly writeScript: (path: string, content: string) => Promise<void>;
  readonly execPath: string;
  readonly graceMs: number;
  /** the current user's processes, to find the terminals they use */
  readonly listProcesses: () => Promise<readonly ProcessInfo[]>;
  readonly pid: number;
  readonly exists: (path: string) => Promise<boolean>;
}

interface Candidate {
  readonly method: LaunchOutcome["method"];
  readonly name: string;
  readonly chosen: TerminalChoice;
  readonly command: string;
  readonly args: readonly string[];
  readonly resolve: boolean;
}

export class SystemTerminalLauncher implements TerminalLauncher {
  constructor(private readonly deps: TerminalLauncherDeps) {}

  async open(
    spec: HarnessLaunchSpec,
    workspacePath: string,
  ): Promise<LaunchOutcome> {
    const { os, env } = this.deps;
    const command = copyCommand(spec, workspacePath, os);
    const fallback = (
      tried: readonly TerminalAttempt[],
      reason?: NoTerminalReason,
    ): LaunchOutcome => ({
      method: "copy_command",
      opened: false,
      command,
      tried,
      ...(reason !== undefined ? { reason } : {}),
    });

    const launcherEnv = this.launcherEnvironment(workspacePath);
    const isWindows = os === "windows";
    const scriptPath = join(
      startDir(workspacePath),
      isWindows ? "launch.cmd" : "launch.command",
    );
    await this.deps.writeScript(
      scriptPath,
      isWindows
        ? renderCmdLauncher(spec, launcherEnv)
        : renderPosixLauncher(spec, launcherEnv),
    );

    if (this.deps.remoteBrowser) return fallback([], "remote_browser");
    if (env("SSH_CONNECTION")) return fallback([], "ssh");

    const tried: TerminalAttempt[] = [];
    for (const candidate of await this.candidates(scriptPath)) {
      const result = await this.tryCandidate(candidate, workspacePath);
      if (result === "opened") {
        return { method: candidate.method, opened: true, command };
      }
      tried.push({
        terminal: candidate.name,
        chosen: candidate.chosen,
        result,
      });
    }
    if (os !== "darwin" && os !== "windows") {
      if (await this.inContainer()) return fallback(tried, "container");
      if (!env("DISPLAY") && !env("WAYLAND_DISPLAY")) {
        return fallback(tried, "no_display");
      }
    }
    return fallback(tried);
  }

  private async inContainer(): Promise<boolean> {
    for (const marker of CONTAINER_MARKERS) {
      if (await this.deps.exists(marker)) return true;
    }
    return false;
  }

  private async tryCandidate(
    candidate: Candidate,
    workspacePath: string,
  ): Promise<"opened" | TerminalAttemptResult> {
    const path = candidate.resolve
      ? await this.deps.resolve(candidate.command)
      : candidate.command;
    if (path === null) return "not_found";
    return await this.tryOpen({ ...candidate, command: path }, workspacePath);
  }

  private launcherEnvironment(workspacePath: string): LauncherEnvironment {
    const exports: Record<string, string> = {};
    for (const name of LAUNCHER_EXPORTED_VARS) {
      const value = this.deps.env(name);
      if (value) exports[name] = value;
    }
    return {
      workspacePath,
      swampBinDir: dirname(this.deps.execPath),
      exports,
      unset: NESTED_SWAMP_ENV_VARS,
    };
  }

  private async candidates(scriptPath: string): Promise<Candidate[]> {
    const { os, env, resolve } = this.deps;
    if (os !== "windows") {
      if (os !== "darwin" && !env("DISPLAY") && !env("WAYLAND_DISPLAY")) {
        return [];
      }
      const terminalVar = os !== "darwin" ? env("TERMINAL") : undefined;
      const planned = orderTerminals({
        os,
        scriptPath,
        ...(terminalVar !== undefined ? { terminalVar } : {}),
        processes: await this.deps.listProcesses().catch(() => []),
        selfPid: this.deps.pid,
      });
      return planned.map((p) => ({
        method: os === "darwin" ? "macos_terminal" : "linux_terminal",
        ...p,
      }));
    }
    // Both are spawned with the workspace as their working directory, and
    // run the launcher by its relative path; see
    // WINDOWS_LAUNCHER_RELATIVE_PATH.
    const wt = await resolve("wt.exe");
    const windows = {
      method: "windows_terminal",
      chosen: "default",
      resolve: false,
    } as const;
    return wt
      ? [{
        ...windows,
        name: "wt.exe",
        command: wt,
        args: ["-d", ".", "cmd", "/k", WINDOWS_LAUNCHER_RELATIVE_PATH],
      }]
      : [{
        ...windows,
        name: "cmd",
        command: "cmd",
        args: ["/c", "start", "", "cmd", "/k", WINDOWS_LAUNCHER_RELATIVE_PATH],
      }];
  }

  /**
   * Starts one candidate. A launcher that exits successfully, or is still
   * running after the grace window (a terminal that blocks until its window
   * closes), counts as opened.
   */
  private async tryOpen(
    candidate: Candidate,
    workspacePath: string,
  ): Promise<"opened" | TerminalAttemptResult> {
    let child: TerminalProcess;
    try {
      child = this.deps.spawn(candidate.command, candidate.args, workspacePath);
    } catch {
      return "couldnt_start";
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stillRunning = new Promise<"running">((resolve) => {
      timer = setTimeout(() => resolve("running"), this.deps.graceMs);
    });
    try {
      const outcome = await Promise.race([child.status, stillRunning]);
      if (outcome === "running") {
        child.unref();
        // Settle the status later without leaving a rejected promise behind.
        child.status.catch(() => {});
        return "opened";
      }
      return outcome.success ? "opened" : "failed";
    } catch {
      return "couldnt_start";
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createSystemTerminalLauncher(
  options: { remoteBrowser?: boolean } = {},
): SystemTerminalLauncher {
  const resolver = defaultCommandResolver();
  const processes = createProcessLister();
  return new SystemTerminalLauncher({
    os: Deno.build.os,
    remoteBrowser: options.remoteBrowser ?? false,
    env: (name) => Deno.env.get(name),
    resolve: (name) => resolver.resolve(name),
    spawn: (command, args, cwd) =>
      new Deno.Command(command, {
        args: [...args],
        cwd,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn(),
    // The script goes in the workspace's `.swamp/start/`; a symlink planted
    // there (or at the script itself) is refused or replaced, never followed.
    writeScript: async (path, content) => {
      await refuseSymlinks([dirname(dirname(path)), dirname(path)]);
      await ensureDir(dirname(path));
      await atomicWriteTextFile(path, content, { mode: 0o700 });
      if (Deno.build.os !== "windows") await Deno.chmod(path, 0o700);
    },
    execPath: Deno.execPath(),
    graceMs: TERMINAL_LAUNCH_GRACE_MS,
    listProcesses: () => processes.list(),
    pid: Deno.pid,
    exists: async (path) => {
      try {
        await Deno.lstat(path);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/**
 * where returns all hits so the caller can prefer a .cmd or .exe over the
 * extensionless npm shim; which returns the first
 */
export async function lookupExecutable(name: string): Promise<string[]> {
  const tool = Deno.build.os === "windows" ? "where" : "which";
  try {
    const output = await new Deno.Command(tool, {
      args: [name],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) return [];
    return new TextDecoder().decode(output.stdout).split(/\r?\n/).map((l) =>
      l.trim()
    ).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}
