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
 * Check if a process with the given PID is no longer running.
 *
 * POSIX hosts use `Deno.kill(pid, "SIGCONT")` — a no-op for live
 * processes, `NotFound` when the PID is gone. Windows shells out to
 * `tasklist`. Returns `false` (not dead) on any unexpected error so
 * TTL-based detection remains the fallback and a busted probe never
 * clobbers a valid lock or tracker row.
 */
export function isProcessDead(pid: number): boolean {
  if (Deno.build.os === "windows") {
    return isProcessDeadWindows(pid);
  }
  try {
    Deno.kill(pid, "SIGCONT");
    return false;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return true;
    }
    return false;
  }
}

const MIN_RECOMMENDED_NOFILE = 8192;

/**
 * Returns the soft open-file limit for this process, or `null` when the
 * value cannot be determined (Windows, unexpected format, etc.).
 *
 * Linux: parses `/proc/self/limits`.
 * macOS: runs `sh -c "ulimit -n"`.
 */
export function getOpenFileSoftLimit(): number | null {
  if (Deno.build.os === "windows") {
    return null;
  }
  if (Deno.build.os === "linux") {
    return getOpenFileSoftLimitLinux();
  }
  return getOpenFileSoftLimitPosix();
}

function getOpenFileSoftLimitLinux(): number | null {
  try {
    const text = Deno.readTextFileSync("/proc/self/limits");
    for (const line of text.split("\n")) {
      if (line.startsWith("Max open files")) {
        const parts = line.replace("Max open files", "").trim().split(/\s+/);
        const soft = parseInt(parts[0], 10);
        return Number.isFinite(soft) ? soft : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function getOpenFileSoftLimitPosix(): number | null {
  try {
    const result = new Deno.Command("sh", {
      args: ["-c", "ulimit -n"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!result.success) return null;
    const value = parseInt(
      new TextDecoder().decode(result.stdout).trim(),
      10,
    );
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Checks the open-file soft limit and returns a warning message if it is
 * below `MIN_RECOMMENDED_NOFILE`.  Returns `null` when the limit is
 * acceptable or cannot be determined.
 */
export function checkOpenFileLimit(): {
  softLimit: number;
  recommended: number;
  message: string;
} | null {
  const limit = getOpenFileSoftLimit();
  if (limit === null || limit >= MIN_RECOMMENDED_NOFILE) return null;
  return {
    softLimit: limit,
    recommended: MIN_RECOMMENDED_NOFILE,
    message:
      `open-file limit is ${limit} — swamp serve may crash under load. ` +
      `Raise it to at least ${MIN_RECOMMENDED_NOFILE} with ` +
      `'ulimit -n ${MIN_RECOMMENDED_NOFILE}' or LimitNOFILE=${MIN_RECOMMENDED_NOFILE} in the systemd unit`,
  };
}

function isProcessDeadWindows(pid: number): boolean {
  try {
    const result = new Deno.Command("tasklist", {
      args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!result.success) {
      return false;
    }
    const stdout = new TextDecoder().decode(result.stdout);
    // tasklist always exits 0 — alive vs dead is signalled by output content.
    // The CSV row (with /NH) always quotes the PID in the second column:
    //   "swamp.exe","1234","Console","1","123,456 K"
    // The "no match" message is localized on non-English Windows
    // (`INFO:` / `信息:` / `情報:` / `INFORMATIONEN:` …) but never
    // contains a bare-quoted PID, so substring-matching `"<pid>"` is
    // locale-agnostic.
    return !stdout.includes(`"${pid}"`);
  } catch {
    return false;
  }
}
