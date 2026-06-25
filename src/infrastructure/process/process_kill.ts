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

function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
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

  // Snapshot children before killing parent (reparented after parent dies)
  const children = await findChildPids(pid);

  try {
    Deno.kill(pid, "SIGTERM");
  } catch { /* race: died between check and kill */ }

  // Poll until parent exits or timeout
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // Force kill parent if still alive
  if (isProcessAlive(pid)) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }

  // Force kill all children
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
