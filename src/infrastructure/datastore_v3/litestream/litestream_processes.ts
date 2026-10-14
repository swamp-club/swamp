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
 * The processes of a v3 writer's Litestream sidecar (swamp-club#3416): how
 * the supervisor is launched, and how another process is recognised before
 * it is signalled.
 *
 * A sidecar is never killed on its pid alone. A supervisor is killed only
 * when its arguments carry the supervisor marker and this database's
 * canonical path, and a Litestream only when its arguments name this
 * database's config: a pidfile can name an unrelated live pid. Arguments
 * come from `/proc/<pid>/cmdline` on Linux (through libc, so the compiled
 * binary needs no --allow-all and the Docker image needs no `ps`) and from
 * `ps` on macOS. A process whose arguments cannot be read is never
 * signalled.
 *
 * @module
 */

import { commandLineOf } from "../../runtime/process_ancestry.ts";

/** The first argument that makes swamp run as a replication supervisor. */
export const SUPERVISOR_MARKER = "__swamp_v3_replication_supervisor";

/** Whether `args`, a process's arguments, start a replication supervisor. */
export function isSupervisorInvocation(args: readonly string[]): boolean {
  return args[0] === SUPERVISOR_MARKER;
}

/** How to launch a supervisor process. */
export interface SupervisorLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The environment to give it; the current one when omitted. */
  readonly env?: Record<string, string>;
}

/** What the sidecar does to processes, replaceable in tests. */
export interface LitestreamProcesses {
  /** Starts a detached process that outlives this one; returns its pid. */
  launch(launch: SupervisorLaunch): number;
  /** The process's arguments as one line, or undefined when unreadable. */
  commandLine(pid: number): Promise<string | undefined>;
  isAlive(pid: number): boolean;
  /** Signals a process; one that is gone already is ignored. */
  signal(pid: number, signal: Deno.Signal): void;
  /** Signals the process group `pgid` leads; a gone group is ignored. */
  signalGroup(pgid: number, signal: Deno.Signal): void;
}

/** Whether `commandLine` is the supervisor of the database at `commitsDb`. */
export function isSupervisorFor(
  commandLine: string | undefined,
  commitsDb: string,
): boolean {
  // The marker and the database, not the exact line: a supervisor started
  // by another swamp build (another install path, `deno run` from source,
  // other timings) is still this database's, and replaceable.
  return commandLine !== undefined &&
    commandLine.includes(SUPERVISOR_MARKER) && commandLine.includes(commitsDb);
}

/** Whether `commandLine` is a Litestream replicating with `configPath`. */
export function isLitestreamFor(
  commandLine: string | undefined,
  configPath: string,
): boolean {
  return commandLine !== undefined && commandLine.includes("replicate") &&
    commandLine.includes(configPath);
}

/** The processes of this host. */
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
