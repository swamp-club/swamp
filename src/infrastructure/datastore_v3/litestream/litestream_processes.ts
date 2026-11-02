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

/**
 * a pidfile can name an unrelated live pid, so signal only a process whose
 * arguments carry the supervisor marker and this database, or name its config;
 * unreadable arguments are never signalled
 */

import { commandLineOf } from "../../runtime/process_ancestry.ts";

export const SUPERVISOR_MARKER = "__swamp_v3_replication_supervisor";

export function isSupervisorInvocation(args: readonly string[]): boolean {
  return args[0] === SUPERVISOR_MARKER;
}

export interface SupervisorLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
}

export interface LitestreamProcesses {
  launch(launch: SupervisorLaunch): number;
  commandLine(pid: number): Promise<string | undefined>;
  isAlive(pid: number): boolean;
  signal(pid: number, signal: Deno.Signal): void;
  signalGroup(pgid: number, signal: Deno.Signal): void;
}

export function isSupervisorFor(
  commandLine: string | undefined,
  commitsDb: string,
): boolean {
  // The marker and the database, not the exact line: a supervisor started
  // by another swamp build (another install path, `deno run` from source,
  // other timings) is still this database's, and replaceable.
  // The database is matched as the whole `--db` argument, bounded by the
  // argument after it, so `/x/tmp/d/commits.db` is not `/tmp/d/commits.db`.
  return commandLine !== undefined &&
    commandLine.includes(
      `${SUPERVISOR_MARKER} --db ${commitsDb} --private-root `,
    );
}

export function isLitestreamFor(
  commandLine: string | undefined,
  configPath: string,
): boolean {
  // The whole argument list the supervisor gives it, so only a Litestream
  // started for this config matches.
  return commandLine !== undefined &&
    commandLine.includes(` replicate -config ${configPath} -no-expand-env`);
}

export const hostLitestreamProcesses: LitestreamProcesses = {
  launch({ command, args, cwd, env }) {
    const child = new Deno.Command(command, {
      args: [...args],
      cwd,
      ...(env !== undefined ? { env, clearEnv: true } : {}),
      stdin: "null",
      stdout: "null",
      stderr: "null",
      // Its own session and process group: it outlives this command, and a
      // group kill reaches its Litestream too.
      detached: true,
    }).spawn();
    child.unref();
    // Nothing waits on it; its status is never read.
    child.status.catch(() => {});
    return child.pid;
  },
  async commandLine(pid) {
    if (Deno.build.os === "linux") return commandLineOf(pid)?.join(" ");
    if (Deno.build.os !== "darwin") return undefined;
    try {
      const output = await new Deno.Command("ps", {
        args: ["-ww", "-o", "command=", "-p", String(pid)],
        env: { LC_ALL: "C" },
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!output.success) return undefined;
      const line = new TextDecoder().decode(output.stdout).trim();
      return line === "" ? undefined : line;
    } catch {
      return undefined;
    }
  },
  isAlive(pid) {
    try {
      Deno.kill(pid, 0);
      return true;
    } catch (error) {
      // Another user's live process answers with a permission error.
      return !(error instanceof Deno.errors.NotFound);
    }
  },
  signal(pid, signal) {
    try {
      Deno.kill(pid, signal);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
  signalGroup(pgid, signal) {
    try {
      Deno.kill(-pgid, signal);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
};
