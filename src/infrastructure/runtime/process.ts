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
import { hostname } from "node:os";

/**
 * hostname plus, on Linux, the pid namespace, so containers sharing a hostname
 * but not pids never read each other's live pid as dead; read via libc FFI, as
 * Deno refuses /proc without --allow-all
 */
export function processHostIdentity(): string {
  if (cachedHostIdentity === undefined) {
    const host = hostname();
    cachedHostIdentity = host;
    if (Deno.build.os === "linux") {
      const namespace = linuxPidNamespace();
      if (namespace !== undefined) cachedHostIdentity = `${host}#${namespace}`;
    }
  }
  return cachedHostIdentity;
}

let cachedHostIdentity: string | undefined;

/**
 * probes with SIGURG, which unlike SIGCONT does not resume a stopped process;
 * Linux checks /proc/<pid> via libc first; permission denied and unexpected
 * errors read as alive
 */
export function isProcessGone(pid: number): boolean {
  if (Deno.build.os === "windows") {
    return isProcessDeadWindows(pid);
  }
  if (Deno.build.os === "linux" && linuxProcEntryExists(pid)) {
    return false;
  }
  try {
    Deno.kill(pid, "SIGURG");
    return false;
  } catch (error) {
    return error instanceof Deno.errors.NotFound;
  }
}

// libc (Linux), for reading /proc past Deno's --allow-all requirement.
const LINUX_LIBC_SYMBOLS = {
  access: { parameters: ["buffer", "i32"], result: "i32" },
  readlink: { parameters: ["buffer", "buffer", "usize"], result: "isize" },
} as const;

type LinuxLibc = Deno.DynamicLibrary<typeof LINUX_LIBC_SYMBOLS>;

const F_OK = 0;
const NAMESPACE_LINK_MAXSIZE = 256;

function withLinuxLibc<T>(use: (lib: LinuxLibc) => T): T | undefined {
  let lib: LinuxLibc;
  try {
    lib = Deno.dlopen("libc.so.6", LINUX_LIBC_SYMBOLS);
  } catch {
    return undefined;
  }
  try {
    return use(lib);
  } catch {
    return undefined;
  } finally {
    lib.close();
  }
}

function cString(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${value}\0`);
}

function linuxProcEntryExists(pid: number): boolean {
  return withLinuxLibc((lib) =>
    lib.symbols.access(cString(`/proc/${pid}`), F_OK) === 0
  ) ?? false;
}

function linuxPidNamespace(): string | undefined {
  return withLinuxLibc((lib) => {
    const buffer = new Uint8Array(NAMESPACE_LINK_MAXSIZE);
    const length = Number(
      lib.symbols.readlink(
        cString("/proc/self/ns/pid"),
        buffer,
        BigInt(NAMESPACE_LINK_MAXSIZE),
      ),
    );
    // A full buffer may be a truncated link; treat it as unreadable.
    if (length <= 0 || length >= NAMESPACE_LINK_MAXSIZE) return undefined;
    return new TextDecoder().decode(buffer.subarray(0, length));
  });
}

const MIN_RECOMMENDED_NOFILE = 8192;

export function getOpenFileSoftLimit(): number | null {
  if (Deno.build.os === "windows") {
    return null;
  }
  if (Deno.build.os === "linux") {
    return getOpenFileSoftLimitLinux() ?? getOpenFileSoftLimitPosix();
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

const RLIMIT_NOFILE = Deno.build.os === "linux" ? 7 : 8;

export type RaiseLimitResult =
  | { raised: true; from: number; to: number }
  | { raised: false; reason: string };

/**
 * raising the soft limit within the administrator-set hard limit is an ordinary
 * unprivileged POSIX operation; the hard limit is the security boundary
 */
export function tryRaiseOpenFileLimit(): RaiseLimitResult {
  if (Deno.build.os === "windows") {
    return { raised: false, reason: "windows" };
  }

  try {
    const libName = Deno.build.os === "darwin"
      ? "libSystem.B.dylib"
      : "libc.so.6";

    const lib = Deno.dlopen(libName, {
      getrlimit: { parameters: ["i32", "buffer"], result: "i32" },
      setrlimit: { parameters: ["i32", "buffer"], result: "i32" },
    });

    try {
      const rlimit = new BigUint64Array(2);
      const buf = new Uint8Array(rlimit.buffer);

      if (lib.symbols.getrlimit(RLIMIT_NOFILE, buf) !== 0) {
        return { raised: false, reason: "getrlimit failed" };
      }

      const soft = Number(rlimit[0]);
      const hard = Number(rlimit[1]);

      if (soft >= MIN_RECOMMENDED_NOFILE) {
        return { raised: false, reason: "already sufficient" };
      }

      const RLIM_INFINITY = 0xFFFFFFFFFFFFFFFFn;
      const effectiveHard = rlimit[1] === RLIM_INFINITY
        ? Number.MAX_SAFE_INTEGER
        : hard;

      if (effectiveHard < MIN_RECOMMENDED_NOFILE) {
        return { raised: false, reason: "hard limit too low" };
      }

      const target = Math.min(effectiveHard, MIN_RECOMMENDED_NOFILE);
      rlimit[0] = BigInt(target);

      if (lib.symbols.setrlimit(RLIMIT_NOFILE, buf) !== 0) {
        return { raised: false, reason: "setrlimit failed" };
      }

      return { raised: true, from: soft, to: target };
    } finally {
      lib.close();
    }
  } catch {
    return { raised: false, reason: "ffi unavailable" };
  }
}

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
    // tasklist always exits 0; alive is signalled by output: the CSV row always
    // quotes the PID and the localized no-match message never does, so matching
    // the quoted pid is locale-agnostic
    return !stdout.includes(`"${pid}"`);
  } catch {
    return false;
  }
}
