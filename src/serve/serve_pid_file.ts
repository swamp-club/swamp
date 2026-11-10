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
    const { pid, startTime } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isInteger(pid)) return undefined;
    return typeof startTime === "string" ? { pid, startTime } : { pid };
  } catch {
    return undefined;
  }
}

export type ServePidVerdict = "match" | "gone" | "reused" | "unknown";

export interface ServePidProbeDeps {
  /** false only when no process has the pid; true when one does, even another user's */
  processExists(pid: number): boolean;
  startTime(pid: number): Promise<string | undefined>;
}

/** unknown when this machine cannot tell; the caller then signals as before */
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
  return started === sidecar.startTime ? "match" : "reused";
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
  let content: string;
  try {
    content = await Deno.readTextFile(pidPath);
  } catch {
    return false;
  }
  if (content.trim() !== String(pid)) return false;
  const sidecar = await readServePidSidecar(pidPath);
  if (sidecar?.pid === pid) {
    await Deno.remove(servePidSidecarPath(pidPath)).catch(() => {});
  }
  try {
    await Deno.remove(pidPath);
    return true;
  } catch {
    return false;
  }
}
