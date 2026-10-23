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
  TerminalLauncher,
} from "../../../domain/start/terminal_launcher.ts";
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
 * The Windows launcher relative to the workspace. The window opens in the
 * workspace (`wt -d .` or `start`, both from a process running there), so
 * the command `cmd /k` runs never contains the workspace path: a folder
 * like `R&D` or `a;b` cannot split it, and `wt` never sees a `;` (its
 * command separator) from the path.
 */
export const WINDOWS_LAUNCHER_RELATIVE_PATH = ".swamp\\start\\launch.cmd";

/** How long a terminal may run before it counts as having opened a window. */
export const TERMINAL_LAUNCH_GRACE_MS = 1500;

/** The parts of a spawned process the launcher uses. */
export interface TerminalProcess {
  readonly status: Promise<{ readonly success: boolean }>;
  unref(): void;
}

/** Dependencies of {@link SystemTerminalLauncher}, injected for testing. */
export interface TerminalLauncherDeps {
  readonly os: typeof Deno.build.os;
  readonly env: (name: string) => string | undefined;
  /** Resolves an executable on PATH to its absolute path. */
  readonly resolve: (name: string) => Promise<string | null>;
  readonly spawn: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => TerminalProcess;
  readonly writeScript: (path: string, content: string) => Promise<void>;
  /** The running swamp binary. */
  readonly execPath: string;
  readonly graceMs: number;
}

interface Candidate {
  readonly method: LaunchOutcome["method"];
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Opens the launcher with the default .command application on macOS,
 * Windows Terminal or `cmd start` on Windows, the first terminal found on
 * Linux. With no display, over SSH, or when every attempt fails, it opens
 * nothing and returns the copy-command outcome.
 */
export class SystemTerminalLauncher implements TerminalLauncher {
  constructor(private readonly deps: TerminalLauncherDeps) {}

  async open(
    spec: HarnessLaunchSpec,
    workspacePath: string,
  ): Promise<LaunchOutcome> {
    const { os, env } = this.deps;
    const command = copyCommand(spec, workspacePath, os);
    const fallback: LaunchOutcome = {
      method: "copy_command",
      opened: false,
      command,
    };

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

    if (env("SSH_CONNECTION")) return fallback;

    for (const candidate of await this.candidates(scriptPath)) {
      if (await this.tryOpen(candidate, workspacePath)) {
        return { method: candidate.method, opened: true, command };
      }
    }
    return fallback;
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
    if (os === "darwin") {
      return [{
        method: "macos_terminal",
        command: "open",
        args: [scriptPath],
      }];
    }
    if (os === "windows") {
      // Both are spawned with the workspace as their working directory, and
      // run the launcher by its relative path; see
      // WINDOWS_LAUNCHER_RELATIVE_PATH.
      const wt = await resolve("wt.exe");
      return wt
        ? [{
          method: "windows_terminal",
          command: wt,
          args: ["-d", ".", "cmd", "/k", WINDOWS_LAUNCHER_RELATIVE_PATH],
        }]
        : [{
          method: "windows_terminal",
          command: "cmd",
          args: [
            "/c",
            "start",
            "",
            "cmd",
            "/k",
            WINDOWS_LAUNCHER_RELATIVE_PATH,
          ],
        }];
    }
    if (!env("DISPLAY") && !env("WAYLAND_DISPLAY")) return [];
    const options: Array<[string | undefined, string]> = [
      [env("TERMINAL"), "-e"],
      ["x-terminal-emulator", "-e"],
      ["gnome-terminal", "--"],
      ["konsole", "-e"],
      ["xfce4-terminal", "-x"],
    ];
    const found: Candidate[] = [];
    for (const [name, flag] of options) {
      if (!name) continue;
      const path = await resolve(name);
      if (path) {
        found.push({
          method: "linux_terminal",
          command: path,
          args: [flag, scriptPath],
        });
      }
    }
    return found;
  }

  /**
   * Starts one candidate. A launcher that exits successfully, or is still
   * running after the grace window (a terminal that blocks until its window
   * closes), counts as opened.
   */
  private async tryOpen(
    candidate: Candidate,
    workspacePath: string,
  ): Promise<boolean> {
    let child: TerminalProcess;
    try {
      child = this.deps.spawn(candidate.command, candidate.args, workspacePath);
    } catch {
      return false;
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
        return true;
      }
      return outcome.success;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The real launcher, wired to this process and machine. */
export function createSystemTerminalLauncher(): SystemTerminalLauncher {
  const resolver = defaultCommandResolver();
  return new SystemTerminalLauncher({
    os: Deno.build.os,
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
  });
}

/**
 * Every PATH hit for an executable, in lookup order: `which` on POSIX
 * (first hit), `where` on Windows (all hits, so the caller can prefer a
 * `.cmd` or `.exe` over the extensionless npm shim).
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
