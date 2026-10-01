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
 * Read-only inspection of this process's live ancestry: who its parent is,
 * that parent's parent, and so on, and which executable each one runs. The
 * auth gate uses it to accept a nested pass only from a live swamp ancestor
 * (design/surfaces/auth-gate.md, "Nested runs").
 *
 * Linux reads /proc and macOS asks libproc, both through libc over FFI:
 * Deno only lets a process read /proc/<pid> with --allow-all, which the
 * compiled binary does not have, while --allow-ffi it does. Windows is not
 * supported and always answers `unknown`, which callers must treat as a
 * failed check.
 */

/** How many hops up the parent chain the walk goes before giving up. */
const MAX_DEPTH = 64;

export type AncestryResult =
  | { readonly kind: "ancestor"; readonly executablePath: string }
  | { readonly kind: "not_ancestor" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Whether `pid` is a live ancestor of this process, and if so the path of
 * the executable it runs. The walk follows the live parent chain upward
 * from this process, so a pid that was reused, or a parent that exited and
 * left this process reparented, can never be reported as an ancestor.
 */
export function findAncestor(pid: number): AncestryResult {
  if (!isInspectable()) {
    return { kind: "unknown", reason: `unsupported on ${Deno.build.os}` };
  }
  try {
    let current = Deno.pid;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const parent = parentPidOf(current);
      if (parent === undefined) {
        return { kind: "unknown", reason: `no parent for pid ${current}` };
      }
      if (parent === pid) {
        const executablePath = executablePathOf(pid);
        return executablePath === undefined
          ? { kind: "unknown", reason: `no executable for pid ${pid}` }
          : { kind: "ancestor", executablePath };
      }
      // pid 0 is the kernel (or no parent); pid 1 has no parent to walk to.
      if (parent <= 1) return { kind: "not_ancestor" };
      current = parent;
    }
    return { kind: "unknown", reason: "parent chain too deep" };
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The parent pid of `pid`, or undefined when it cannot be read (the process
 * is gone, belongs to another user, or the platform is unsupported).
 */
export function parentPidOf(pid: number): number | undefined {
  switch (Deno.build.os) {
    case "linux":
      return withLibc((lib) => linuxParentPid(lib, pid));
    case "darwin":
      return withLibproc((lib) => darwinParentPid(lib, pid));
    default:
      return undefined;
  }
}

/**
 * The path of the executable `pid` runs, or undefined when it cannot be
 * read. A binary replaced on disk while the process runs (as `swamp update`
 * does) still reports the path it was started from.
 */
export function executablePathOf(pid: number): string | undefined {
  switch (Deno.build.os) {
    case "linux":
      return withLibc((lib) => linuxExecutablePath(lib, pid));
    case "darwin":
      return withLibproc((lib) => darwinExecutablePath(lib, pid));
    default:
      return undefined;
  }
}

/**
 * The parent pid from the text of /proc/<pid>/stat, or undefined when it is
 * malformed. The command name sits in parentheses and may itself contain
 * spaces and parentheses, so the fields are read after its last `)`.
 */
export function parseProcStatParentPid(stat: string): number | undefined {
  const end = stat.lastIndexOf(")");
  if (end === -1) return undefined;
  // After the name: " <state> <ppid> ..."
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : undefined;
}

const DELETED_SUFFIX = " (deleted)";

/**
 * Linux marks the target of /proc/<pid>/exe with " (deleted)" once the file
 * has been replaced or removed. Strip it so a process whose binary was
 * updated in place still reports its install path.
 */
export function stripDeletedSuffix(path: string): string {
  return path.endsWith(DELETED_SUFFIX)
    ? path.slice(0, -DELETED_SUFFIX.length)
    : path;
}

function isInspectable(): boolean {
  return Deno.build.os === "linux" || Deno.build.os === "darwin";
}

// libc (Linux), for reading /proc past Deno's --allow-all requirement.
const O_RDONLY = 0;
/** Comfortably more than any /proc/<pid>/stat line. */
const PROC_STAT_MAXSIZE = 4096;
/** PATH_MAX. */
const PATH_MAXSIZE = 4096;

const LIBC_SYMBOLS = {
  open: { parameters: ["buffer", "i32"], result: "i32" },
  read: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  close: { parameters: ["i32"], result: "i32" },
  readlink: { parameters: ["buffer", "buffer", "usize"], result: "isize" },
} as const;

type Libc = Deno.DynamicLibrary<typeof LIBC_SYMBOLS>;

function withLibc<T>(use: (lib: Libc) => T | undefined): T | undefined {
  let lib: Libc;
  try {
    lib = Deno.dlopen("libc.so.6", LIBC_SYMBOLS);
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

function linuxParentPid(lib: Libc, pid: number): number | undefined {
  const fd = lib.symbols.open(cString(`/proc/${pid}/stat`), O_RDONLY);
  if (fd < 0) return undefined;
  try {
    const buffer = new Uint8Array(PROC_STAT_MAXSIZE);
    const length = Number(
      lib.symbols.read(fd, buffer, BigInt(PROC_STAT_MAXSIZE)),
    );
    if (length <= 0) return undefined;
    return parseProcStatParentPid(
      new TextDecoder().decode(buffer.subarray(0, length)),
    );
  } finally {
    lib.symbols.close(fd);
  }
}

function linuxExecutablePath(lib: Libc, pid: number): string | undefined {
  const buffer = new Uint8Array(PATH_MAXSIZE);
  const length = Number(
    lib.symbols.readlink(
      cString(`/proc/${pid}/exe`),
      buffer,
      BigInt(PATH_MAXSIZE),
    ),
  );
  // A full buffer may be a truncated path; treat it as unreadable.
  if (length <= 0 || length >= PATH_MAXSIZE) return undefined;
  return stripDeletedSuffix(
    new TextDecoder().decode(buffer.subarray(0, length)),
  );
}

// libproc (macOS): <libproc.h> and <sys/proc_info.h>.
const PROC_PIDTBSDINFO = 3;
/** sizeof(struct proc_bsdinfo). */
const PROC_BSDINFO_SIZE = 136;
/** offsetof(struct proc_bsdinfo, pbi_pid). */
const PBI_PID_OFFSET = 12;
/** offsetof(struct proc_bsdinfo, pbi_ppid). */
const PBI_PPID_OFFSET = 16;
/** PROC_PIDPATHINFO_MAXSIZE: 4 * MAXPATHLEN. */
const PROC_PIDPATH_MAXSIZE = 4096;

const LIBPROC_SYMBOLS = {
  proc_pidinfo: {
    parameters: ["i32", "i32", "u64", "buffer", "i32"],
    result: "i32",
  },
  proc_pidpath: { parameters: ["i32", "buffer", "u32"], result: "i32" },
} as const;

type Libproc = Deno.DynamicLibrary<typeof LIBPROC_SYMBOLS>;

function withLibproc<T>(use: (lib: Libproc) => T | undefined): T | undefined {
  let lib: Libproc;
  try {
    lib = Deno.dlopen("libSystem.B.dylib", LIBPROC_SYMBOLS);
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

function darwinParentPid(lib: Libproc, pid: number): number | undefined {
  const info = new Uint8Array(PROC_BSDINFO_SIZE);
  const written = lib.symbols.proc_pidinfo(
    pid,
    PROC_PIDTBSDINFO,
    0n,
    info,
    PROC_BSDINFO_SIZE,
  );
  if (written !== PROC_BSDINFO_SIZE) return undefined;
  const view = new DataView(info.buffer);
  // A struct that does not echo the pid back was not filled as expected.
  if (view.getUint32(PBI_PID_OFFSET, true) !== pid) return undefined;
  return view.getUint32(PBI_PPID_OFFSET, true);
}

function darwinExecutablePath(lib: Libproc, pid: number): string | undefined {
  const buffer = new Uint8Array(PROC_PIDPATH_MAXSIZE);
  const length = lib.symbols.proc_pidpath(pid, buffer, PROC_PIDPATH_MAXSIZE);
  if (length <= 0) return undefined;
  return new TextDecoder().decode(buffer.subarray(0, length));
}

/**
 * Whether two executable paths name the same file, comparing resolved paths
 * where they still exist. A path that no longer resolves (a binary replaced
 * since it started) is compared as written.
 */
export function isSameExecutable(path: string, other: string): boolean {
  return resolveIfPossible(path) === resolveIfPossible(other);
}

function resolveIfPossible(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    return path;
  }
}
