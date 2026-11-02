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
 * macOS ordering barrier for chunk storage: Deno's sync() is F_FULLFSYNC, a
 * whole-drive flush, but a chunk only needs to land before the commit naming
 * it; called via libc FFI since Deno doesn't expose it
 */

const F_BARRIERFSYNC = 85;
const O_RDONLY = 0x0;
const O_CLOEXEC = 0x01000000;

const LIBSYSTEM_SYMBOLS = {
  // Variadic in C; no O_CREAT is passed, so no mode follows.
  open: { parameters: ["buffer", "i32"], result: "i32" },
  // Off the event loop, so concurrent barriers overlap as `FsFile.sync()`
  // calls do.
  fcntl: { parameters: ["i32", "i32"], result: "i32", nonblocking: true },
  close: { parameters: ["i32"], result: "i32" },
} as const;

export type BarrierSyncResult = "synced" | "unsupported";

export interface BarrierLibc {
  open(path: Uint8Array<ArrayBuffer>, flags: number): number;
  fcntl(fd: number, cmd: number): Promise<number>;
  close(fd: number): number;
}

export type BarrierLibcLoader = () => BarrierLibc | undefined;

let libSystem: { readonly libc: BarrierLibc | undefined } | undefined;

/**
 * loads libSystem.B.dylib once per process since a load per barrier costs more
 * than the barrier; a failed load is remembered too
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
 * never throws: unloadable libc, an unopenable path or a volume refusing the
 * call answer unsupported and the caller does a full sync; nonblocking calls
 * can't read errno, so I/O errors do too
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
