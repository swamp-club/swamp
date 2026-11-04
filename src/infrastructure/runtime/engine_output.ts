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

/** Private output pipe supplied by the trusted Go supervisor, never fd 1. */
export interface EngineOutput {
  readonly stream: WritableStream<Uint8Array>;
  dispose(): Promise<void>;
}

/** Native adapter seam; the stream owns this pipe and closes it once. */
export interface EngineOutputPipe {
  write(bytes: Uint8Array): Promise<number>;
  close(): void;
}

/** Account for partial native writes without buffering a second frame queue. */
export function createEngineOutput(pipe: EngineOutputPipe): EngineOutput {
  let closing = false;
  let closed = false;
  let pending: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    closing = true;
    disposal ??= (async () => {
      await pending.catch(() => {});
      if (!closed) {
        closed = true;
        pipe.close();
      }
    })();
    return disposal;
  };
  const stream = new WritableStream<Uint8Array>({
    write(bytes) {
      pending = (async () => {
        if (closing) throw new Error("Engine output pipe is closed");
        let offset = 0;
        while (offset < bytes.length) {
          let written: number;
          try {
            written = await pipe.write(bytes.subarray(offset));
          } catch {
            throw new Error("Engine output pipe write failed");
          }
          if (
            !Number.isInteger(written) || written <= 0 ||
            written > bytes.length - offset
          ) throw new Error("Engine output pipe write failed");
          offset += written;
        }
      })();
      return pending;
    },
    close: dispose,
    abort: dispose,
  });
  return { stream, dispose };
}

const UNIX_SYMBOLS = {
  // These commands take no variadic argument. A fixed third F_SETFD argument
  // is ABI-incompatible with Apple Silicon, where varargs go on the stack.
  fcntl: { parameters: ["i32", "i32"], result: "i32" },
  ioctl: { parameters: ["i32", "usize"], result: "i32" },
  write: {
    parameters: ["i32", "buffer", "usize"],
    result: "isize",
    nonblocking: true,
  },
  close: { parameters: ["i32"], result: "i32" },
} as const;

const WINDOWS_SYMBOLS = {
  SetHandleInformation: {
    parameters: ["pointer", "u32", "u32"],
    result: "i32",
  },
  WriteFile: {
    parameters: ["pointer", "buffer", "u32", "buffer", "pointer"],
    result: "i32",
    nonblocking: true,
  },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
} as const;

/** Validate the private argv without narrowing a Windows HANDLE to a number. */
export function parseEngineOutputTarget(
  flag: string,
  value: string,
  os: string = Deno.build.os,
): bigint {
  if (!/^[0-9]{1,20}$/.test(value)) {
    throw new Error("Invalid inherited engine output pipe");
  }
  const target = BigInt(value);
  if (
    os === "windows"
      ? flag !== "--output-handle" || target <= 0n ||
        target >= 0xffffffffffffffffn
      : flag !== "--output-fd" || target < 3n || target > 0x7fffffffn
  ) throw new Error("Invalid inherited engine output pipe");
  return target;
}

/**
 * The supervisor connects ordinary stdout/stderr to the null device before
 * Deno starts: Deno caches child-inherited stdio before JavaScript bootstrap.
 * This dedicated pipe is made non-inheritable before loading extension code.
 * Windows uses Win32 directly because Deno's static CRT has a separate fd table
 * from ucrtbase.dll; a CRT fd allocated through FFI cannot be adopted safely.
 */
export function openEngineOutput(flag: string, value: string): EngineOutput {
  const target = parseEngineOutputTarget(flag, value);
  if (Deno.build.os === "windows") {
    const handle = Deno.UnsafePointer.create(target);
    const library = Deno.dlopen("kernel32.dll", WINDOWS_SYMBOLS);
    if (!library.symbols.SetHandleInformation(handle, 1, 0)) {
      library.symbols.CloseHandle(handle);
      library.close();
      throw new Error("Cannot secure inherited engine output pipe");
    }
    return createEngineOutput({
      async write(bytes) {
        const written = new Uint32Array(1);
        const ok = await library.symbols.WriteFile(
          handle,
          bytes,
          bytes.length,
          written,
          null,
        );
        return ok ? written[0] : -1;
      },
      close() {
        library.symbols.CloseHandle(handle);
        library.close();
      },
    });
  }
  const fd = Number(target);
  const library = Deno.dlopen(
    Deno.build.os === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
    UNIX_SYMBOLS,
  );
  // FIOCLEX has no data argument (Darwin _IO('f', 1), Linux 0x5451).
  // Read F_GETFD back and fail closed before any extensions are imported.
  const fioclex = Deno.build.os === "darwin" ? 0x20006601n : 0x5451n;
  const secured = library.symbols.ioctl(fd, fioclex);
  const flags = library.symbols.fcntl(fd, 1); // F_GETFD
  if (secured < 0 || flags < 0 || (flags & 1) === 0) {
    library.symbols.close(fd);
    library.close();
    throw new Error("Cannot secure inherited engine output pipe");
  }
  return createEngineOutput({
    async write(bytes) {
      return Number(
        await library.symbols.write(fd, bytes, BigInt(bytes.length)),
      );
    },
    close() {
      library.symbols.close(fd);
      library.close();
    },
  });
}
