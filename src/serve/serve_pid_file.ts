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

export interface ServePidRecord {
  readonly pid: number;
  readonly startTime?: string;
  /** the serve binary's file name, as its command line shows it */
  readonly executable?: string;
}

/** beside serve.pid, which stays a bare PID for kill -HUP and systemd */
export function servePidSidecarPath(pidPath: string): string {
  return `${pidPath}.json`;
}

/** the sidecar first, so a reader that finds serve.pid also finds it */
export async function writeServePidFiles(
  pidPath: string,
  record: ServePidRecord,
): Promise<void> {
  await Deno.writeTextFile(
    servePidSidecarPath(pidPath),
    JSON.stringify(record),
  );
  await Deno.writeTextFile(pidPath, String(record.pid));
}

export async function readServePidSidecar(
  pidPath: string,
): Promise<ServePidRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await Deno.readTextFile(servePidSidecarPath(pidPath)),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { pid, startTime, executable } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isInteger(pid)) return undefined;
    return {
      pid,
      ...(typeof startTime === "string" ? { startTime } : {}),
      ...(typeof executable === "string" ? { executable } : {}),
    };
  } catch {
    return undefined;
  }
}

export type ServePidVerdict = "match" | "gone" | "reused" | "unknown";

export interface ServePidProbeDeps {
  /** false only when no process has the pid; true when one does, even another user's */
  processExists(pid: number): boolean;
  startTime(pid: number): Promise<string | undefined>;
  command(pid: number): Promise<string | undefined>;
}

/**
 * unknown when this machine cannot tell, the caller then signalling as before;
 * Linux derives a start time from a boot time that moves when the clock is
 * stepped, so a differing start time refuses only a process that is not serve
 */
export async function probeServePid(
  pid: number,
  sidecar: ServePidRecord | undefined,
  deps: ServePidProbeDeps,
): Promise<ServePidVerdict> {
  if (!deps.processExists(pid)) return "gone";
  if (sidecar === undefined || sidecar.pid !== pid) return "unknown";
  if (sidecar.startTime === undefined) return "unknown";
  const started = await deps.startTime(pid);
  if (started === undefined) return "unknown";
  if (started === sidecar.startTime) return "match";
  if (sidecar.executable === undefined) return "unknown";
  const command = await deps.command(pid);
  if (command === undefined) return "unknown";
  return command.includes(sidecar.executable) && /\bserve\b/.test(command)
    ? "unknown"
    : "reused";
}

export function processExists(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (err) {
    return !(err instanceof Deno.errors.NotFound);
  }
}

/**
 * Removes the reload PID file and its sidecar only while they still name this
 * process, so a serve that started after this one keeps its own.
 */
export async function removePidFileIfOurs(
  pidPath: string,
  pid: number,
): Promise<boolean> {
  // a sidecar left by a failed serve.pid write is this serve's too
  const sidecar = await readServePidSidecar(pidPath);
  if (sidecar?.pid === pid) {
    await Deno.remove(servePidSidecarPath(pidPath)).catch(() => {});
  }
  let content: string;
  try {
    content = await Deno.readTextFile(pidPath);
  } catch {
    return false;
  }
  if (content.trim() !== String(pid)) return false;
  try {
    await Deno.remove(pidPath);
    return true;
  } catch {
    return false;
  }
}
