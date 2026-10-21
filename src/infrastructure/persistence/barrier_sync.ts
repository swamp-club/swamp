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
 * The macOS ordering barrier, `fcntl(F_BARRIERFSYNC)`, for the filesystem
 * chunk storage (swamp-club#3737). Deno's `FsFile.sync()` on macOS is
 * `F_FULLFSYNC`, which flushes the whole drive cache; a chunk only needs to
 * reach the disk no later than the commit naming it, which the barrier gives
 * without the flush. Deno does not expose it, so it is called through libc
 * over FFI, which the compiled binary allows (`--allow-ffi`).
 *
 * @module
 */

/** `F_BARRIERFSYNC` in macOS `<sys/fcntl.h>`. */
const F_BARRIERFSYNC = 85;
const O_RDONLY = 0x0;
/** `O_CLOEXEC` in macOS `<sys/fcntl.h>`. */
const O_CLOEXEC = 0x01000000;

const LIBSYSTEM_SYMBOLS = {
  // Variadic in C; no O_CREAT is passed, so no mode follows.
  open: { parameters: ["buffer", "i32"], result: "i32" },
  // Off the event loop, so concurrent barriers overlap as `FsFile.sync()`
  // calls do.
  fcntl: { parameters: ["i32", "i32"], result: "i32", nonblocking: true },
  close: { parameters: ["i32"], result: "i32" },
} as const;

/** Whether a barrier ran, or the path's volume (or libc) refused it. */
export type BarrierSyncResult = "synced" | "unsupported";

/** The libc calls a barrier makes; injectable so tests drive each branch. */
export interface BarrierLibc {
  open(path: Uint8Array<ArrayBuffer>, flags: number): number;
  fcntl(fd: number, cmd: number): Promise<number>;
  close(fd: number): number;
}

/** libc, or undefined when it cannot be loaded. */
export type BarrierLibcLoader = () => BarrierLibc | undefined;

/** The process's libc: loaded at the first barrier, then kept. */
let libSystem: { readonly libc: BarrierLibc | undefined } | undefined;

/**
 * Loads `libSystem.B.dylib`, macOS's libc, once per process: a load per
 * barrier costs more than the barrier (swamp-club#3737). A failed load is
 * remembered too.
 */
export const loadLibSystem: BarrierLibcLoader = () => {
  if (libSystem === undefined) {
    try {
      libSystem = {
        libc: Deno.dlopen("libSystem.B.dylib", LIBSYSTEM_SYMBOLS).symbols,
      };
    } catch {
      libSystem = { libc: undefined };
    }
  }
  return libSystem.libc;
};

/**
 * Runs `F_BARRIERFSYNC` on the file or directory at `path`: everything
 * written to it before reaches the disk before anything written to the same
 * device after. It never throws: libc that cannot be loaded, a path that
 * cannot be opened and a volume that refuses the call (network filesystems,
 * some others) all answer `unsupported`, and the caller falls back to a full
 * sync. A nonblocking call cannot read `errno`, so an I/O error answers
 * `unsupported` too; the full sync then reports it.
 */
export async function barrierSync(
  path: string,
  load: BarrierLibcLoader = loadLibSystem,
): Promise<BarrierSyncResult> {
  const libc = load();
  if (libc === undefined) return "unsupported";
  try {
    const fd = libc.open(
      new TextEncoder().encode(`${path}\0`),
      O_RDONLY | O_CLOEXEC,
    );
    if (fd < 0) return "unsupported";
    try {
      return (await libc.fcntl(fd, F_BARRIERFSYNC)) === 0
        ? "synced"
        : "unsupported";
    } finally {
      libc.close(fd);
    }
  } catch {
    return "unsupported";
  }
}
