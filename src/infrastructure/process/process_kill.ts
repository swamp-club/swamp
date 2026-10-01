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

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["process", "kill"]);

/**
 * Verifies that the process at the given PID is a swamp process by
 * inspecting its command line. Returns false if the PID doesn't exist
 * or belongs to a different program — guarding against PID reuse.
 */
async function isSwampProcess(pid: number): Promise<boolean> {
  // Windows lacks `ps`; skip verification and trust the caller's PID.
  if (Deno.build.os === "windows") return true;

  try {
    const cmd = new Deno.Command("ps", {
      args: ["-p", String(pid), "-o", "command="],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    if (!output.success) return false;
    const cmdline = new TextDecoder().decode(output.stdout).trim();
    return cmdline.includes("swamp");
  } catch {
    return false;
  }
}

async function findChildPids(ppid: number): Promise<number[]> {
  try {
    if (Deno.build.os === "windows") {
      const cmd = new Deno.Command("wmic", {
        args: [
          "process",
          "where",
          `(ParentProcessId=${ppid})`,
          "get",
          "ProcessId",
        ],
        stdout: "piped",
        stderr: "null",
      });
      const output = await cmd.output();
      const text = new TextDecoder().decode(output.stdout).trim();
      if (!text) return [];
      // wmic output has a header line ("ProcessId") followed by PID values
      return text.split("\n").map((l) => l.trim()).map(Number).filter((n) =>
        !isNaN(n)
      );
    }

    const cmd = new Deno.Command("pgrep", {
      args: ["-P", String(ppid)],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    const text = new TextDecoder().decode(output.stdout).trim();
    if (!text) return [];
    return text.split("\n").map(Number).filter((n) => !isNaN(n));
  } catch {
    return [];
  }
}

/**
 * The start time `ps` reports for each of `pids` still running, keyed by pid.
 * A pid that later reports a different start time belongs to another
 * process. Returns undefined where start times cannot be read (Windows, or
 * `ps` failing), and callers then trust the pids as before.
 */
async function processStartTimes(
  pids: readonly number[],
): Promise<Map<number, string> | undefined> {
  if (Deno.build.os === "windows") return undefined;
  const starts = new Map<number, string>();
  if (pids.length === 0) return starts;
  try {
    const cmd = new Deno.Command("ps", {
      args: ["-o", "pid=,lstart=", "-p", pids.join(",")],
      stdout: "piped",
      stderr: "null",
    });
    // ps exits non-zero when any pid is gone; the rest are still listed.
    const output = await cmd.output();
    for (const line of new TextDecoder().decode(output.stdout).split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match) starts.set(Number(match[1]), match[2]);
    }
  } catch {
    return undefined;
  }
  return starts;
}

/**
 * Drops the pids that now belong to another process: those whose start time
 * in `after` differs from the one in `before`. A pid missing from `after` no
 * longer exists and is kept: while its process group lives on, the kernel
 * does not hand the pid out again, so a group kill still reaches the group
 * safely. Without start times on either side, every pid is kept.
 */
export function withoutReusedPids(
  pids: readonly number[],
  before: ReadonlyMap<number, string> | undefined,
  after: ReadonlyMap<number, string> | undefined,
): number[] {
  if (before === undefined || after === undefined) return [...pids];
  return pids.filter((pid) =>
    !after.has(pid) || after.get(pid) === before.get(pid)
  );
}

/**
 * Whether a signal can still reach `pid`. A negative `pid` probes the process
 * group `-pid`, which stays alive while any member remains.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGKILLs the process group led by each of `pids`. Shell steps run as their
 * own group leaders when isolated (see `process_group_policy.ts`), so this
 * reaches the grandchildren a step left behind. A pid that does not lead a
 * group has no group of that id, and the kill fails harmlessly.
 */
export function killChildGroups(pids: readonly number[]): void {
  if (Deno.build.os === "windows") return;
  for (const pid of pids) {
    try {
      Deno.kill(-pid, "SIGKILL");
    } catch { /* not a group leader, or the group is gone */ }
  }
}

/**
 * Kills a process tree (parent + children) after verifying the parent is
 * a swamp process. Sends SIGTERM for graceful shutdown, waits up to
 * {@link maxWaitMs} for exit, then SIGKILL anything still alive.
 *
 * Returns true if the process was found and killed, false if the PID was
 * not a swamp process (PID reuse) or already dead.
 */
export async function killProcessTree(
  pid: number,
  { maxWaitMs = 2000 }: { maxWaitMs?: number } = {},
): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }

  if (!await isSwampProcess(pid)) {
    logger
      .warn`PID ${pid} is not a swamp process — skipping kill (possible PID reuse)`;
    return false;
  }

  // Snapshot children before killing parent (reparented after parent dies),
  // with their start times so a pid reused during the wait is left alone.
  const snapshot = await findChildPids(pid);
  const snapshotStarts = await processStartTimes(snapshot);

  try {
    Deno.kill(pid, "SIGTERM");
  } catch { /* race: died between check and kill */ }

  // Poll until parent exits or timeout
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // Force kill parent if still alive. Snapshot its children again first:
  // work it started while handling SIGTERM (a workflow's cleanup steps) is
  // missing from the first snapshot and would outlive it.
  let current: number[] = [];
  if (isProcessAlive(pid)) {
    current = await findChildPids(pid);
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }

  // A first-snapshot child that exited during the wait may have handed its
  // pid to an unrelated process; that pid is left alone.
  const children = [
    ...current,
    ...withoutReusedPids(
      snapshot.filter((child) => !current.includes(child)),
      snapshotStarts,
      await processStartTimes(snapshot),
    ),
  ];

  // Force kill all children, and the process groups isolated shell steps
  // lead: swamp was SIGKILLed or exited, so its own escalation never ran.
  killChildGroups(children);
  for (const child of children) {
    if (isProcessAlive(child)) {
      try {
        Deno.kill(child, "SIGKILL");
      } catch { /* already gone */ }
    }
  }

  // Final wait for everything to be gone
  const finalDeadline = Date.now() + 500;
  while (Date.now() < finalDeadline) {
    const anyAlive = [pid, ...children].some(isProcessAlive);
    if (!anyAlive) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  return true;
}
