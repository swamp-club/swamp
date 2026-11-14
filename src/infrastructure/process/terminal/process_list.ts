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

import { basename, join } from "@std/path";
import type {
  ProcessInfo,
  ProcessLister,
} from "../../../domain/start/terminal_launcher.ts";

export const MAX_PROCESSES = 4096;
export const PS_TIMEOUT_MS = 2000;

/** a pid that exits mid-scan, or one not readable, is skipped */
export async function readLinuxProcesses(
  procRoot: string,
  uid: number,
): Promise<ProcessInfo[]> {
  const pids: number[] = [];
  try {
    for await (const entry of Deno.readDir(procRoot)) {
      if (/^\d+$/.test(entry.name)) pids.push(Number(entry.name));
    }
  } catch {
    return [];
  }
  // past the cap the newest processes are kept: an open terminal is likelier there
  const found: ProcessInfo[] = [];
  for (const pid of pids.sort((a, b) => b - a).slice(0, MAX_PROCESSES)) {
    const info = await readLinuxProcess(join(procRoot, String(pid)), uid);
    if (info !== null) found.push(info);
  }
  return found;
}

async function readLinuxProcess(
  dir: string,
  uid: number,
): Promise<ProcessInfo | null> {
  try {
    const status = await Deno.readTextFile(join(dir, "status"));
    const owner = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    const ppid = /^PPid:\s+(\d+)/m.exec(status)?.[1];
    if (owner === undefined || ppid === undefined || Number(owner) !== uid) {
      return null;
    }
    return {
      pid: Number(basename(dir)),
      ppid: Number(ppid),
      name: await linuxProcessName(dir),
    };
  } catch {
    return null;
  }
}

/** the exe link carries the full name; comm is cut to 15 characters */
async function linuxProcessName(dir: string): Promise<string> {
  try {
    const target = await Deno.readLink(join(dir, "exe"));
    return basename(target.replace(/ \(deleted\)$/, ""));
  } catch {
    return (await Deno.readTextFile(join(dir, "comm"))).trim();
  }
}

/** `ps -o pid=,ppid=,comm=` lines; comm is the executable's full path */
export function parsePsOutput(output: string): ProcessInfo[] {
  const found: ProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    found.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: basename(match[3]),
    });
    if (found.length >= MAX_PROCESSES) break;
  }
  return found;
}

async function readMacProcesses(): Promise<ProcessInfo[]> {
  try {
    const output = await new Deno.Command("ps", {
      args: ["-x", "-o", "pid=,ppid=,comm="],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(PS_TIMEOUT_MS),
    }).output();
    if (!output.success) return [];
    return parsePsOutput(new TextDecoder().decode(output.stdout));
  } catch {
    return [];
  }
}

export function createProcessLister(
  os: typeof Deno.build.os = Deno.build.os,
): ProcessLister {
  return {
    list: async () => {
      if (os === "darwin") return await readMacProcesses();
      const uid = Deno.uid();
      if (os !== "linux" || uid === null) return [];
      return await readLinuxProcesses("/proc", uid);
    },
  };
}
