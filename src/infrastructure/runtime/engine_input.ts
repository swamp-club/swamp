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

/** Private request pipe; ordinary stdin is the null device before Deno starts. */
export interface EngineInput {
  readonly stream: ReadableStream<Uint8Array>;
  dispose(): Promise<void>;
}

/** Native adapter seam. Reads must settle on cancellation without closing under native code. */
export interface EngineInputPipe {
  read(bytes: Uint8Array, signal: AbortSignal): Promise<number>;
  close(): void;
}

/** One bounded read at a time, with cancellation and exactly-once ownership. */
export function createEngineInput(pipe: EngineInputPipe): EngineInput {
  const cancellation = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closing = false;
  let closed = false;
  let pending: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | undefined;
  const close = () => {
    if (!closed) {
      closed = true;
      pipe.close();
    }
  };
  const dispose = (): Promise<void> => {
    closing = true;
    cancellation.abort();
    try {
      controller.close();
    } catch {
      // Stream cancellation/error has already closed the reader's side.
    }
    disposal ??= (async () => {
      await pending.catch(() => {});
      close();
    })();
    return disposal;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull() {
      if (closing) return;
      const bytes = new Uint8Array(64 * 1024);
      pending = (async () => {
        try {
          const count = await pipe.read(bytes, cancellation.signal);
          if (closing) return;
          if (!Number.isInteger(count) || count < 0 || count > bytes.length) {
            throw new Error("Invalid native read");
          }
          if (count === 0) {
            closing = true;
            controller.close();
          } else {
            controller.enqueue(bytes.subarray(0, count));
          }
        } catch {
          if (!closing) {
            closing = true;
            controller.error(new Error("Engine input pipe read failed"));
          }
        }
      })();
      await pending;
      if (closing) close();
    },
    cancel: dispose,
  }, { highWaterMark: 0 });
  return { stream, dispose };
}

const UNIX_SYMBOLS = {
  // FIOCLEX has no variadic argument, including on Apple Silicon.
  fcntl: { parameters: ["i32", "i32"], result: "i32" },
  ioctl: { parameters: ["i32", "usize"], result: "i32" },
  poll: {
    parameters: ["buffer", "usize", "i32"],
    result: "i32",
    nonblocking: true,
  },
  read: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  close: { parameters: ["i32"], result: "i32" },
} as const;

const WINDOWS_SYMBOLS = {
  SetHandleInformation: {
    parameters: ["pointer", "u32", "u32"],
    result: "i32",
  },
  PeekNamedPipe: {
    parameters: ["pointer", "pointer", "u32", "pointer", "buffer", "pointer"],
    result: "i32",
  },
  GetLastError: { parameters: [], result: "u32" },
  ReadFile: {
    parameters: ["pointer", "buffer", "u32", "buffer", "pointer"],
    result: "i32",
  },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
} as const;

/** Windows anonymous pipes have no readiness wait; cancellation wakes this poll immediately. */
function waitForInput(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 10);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Validate trusted private argv without narrowing Windows HANDLE values. */
export function parseEngineInputTarget(
  flag: string,
  value: string,
  os: string = Deno.build.os,
): bigint {
  if (!/^[0-9]{1,20}$/.test(value)) {
    throw new Error("Invalid inherited engine input pipe");
  }
  const target = BigInt(value);
  if (
    os === "windows"
      ? flag !== "--input-handle" || target <= 0n ||
        target >= 0xffffffffffffffffn
      : flag !== "--input-fd" || target < 3n || target > 0x7fffffffn
  ) throw new Error("Invalid inherited engine input pipe");
  return target;
}

/** Make the request channel non-inheritable before any extension code runs. */
export function openEngineInput(flag: string, value: string): EngineInput {
  const target = parseEngineInputTarget(flag, value);
  if (Deno.build.os === "windows") {
    const handle = Deno.UnsafePointer.create(target);
    const library = Deno.dlopen("kernel32.dll", WINDOWS_SYMBOLS);
    if (!library.symbols.SetHandleInformation(handle, 1, 0)) {
      library.symbols.CloseHandle(handle);
      library.close();
      throw new Error("Cannot secure inherited engine input pipe");
    }
    return createEngineInput({
      async read(bytes, signal) {
        const available = new Uint32Array(1);
        while (!signal.aborted) {
          const ready = library.symbols.PeekNamedPipe(
            handle,
            null,
            0,
            null,
            available,
            null,
          );
          if (!ready) {
            const code = library.symbols.GetLastError();
            if (code === 109 || code === 232) return 0; // Broken/closed pipe.
            throw new Error("Engine input pipe readiness failed");
          }
          if (available[0] > 0) {
            const read = new Uint32Array(1);
            // The private pipe has exactly one reader. Read only bytes already
            // available, so synchronous ReadFile cannot wait for the parent.
            const ok = library.symbols.ReadFile(
              handle,
              bytes,
              Math.min(available[0], bytes.length),
              read,
              null,
            );
            return ok ? read[0] : -1;
          }
          await waitForInput(signal);
        }
        return 0;
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
  const fioclex = Deno.build.os === "darwin" ? 0x20006601n : 0x5451n;
  const secured = library.symbols.ioctl(fd, fioclex);
  const flags = library.symbols.fcntl(fd, 1);
  if (secured < 0 || flags < 0 || (flags & 1) === 0) {
    library.symbols.close(fd);
    library.close();
    throw new Error("Cannot secure inherited engine input pipe");
  }
  return createEngineInput({
    async read(bytes, signal) {
      // pollfd is an int fd followed by short events and short revents.
      const descriptor = new Int32Array([fd, 0]);
      const events = new Int16Array(descriptor.buffer);
      events[2] = 1; // POLLIN
      let interrupted = 0;
      while (!signal.aborted) {
        events[3] = 0;
        const ready = await library.symbols.poll(descriptor, 1n, 100);
        if (signal.aborted) return 0;
        if (ready < 0) {
          // Signals can interrupt poll. Bound repeated failures without trying
          // to read worker-thread errno from the JavaScript thread.
          if (++interrupted > 8) return -1;
          continue;
        }
        interrupted = 0;
        if (ready === 0) continue;
        if (events[3] & 32) return -1; // POLLNVAL
        if (events[3] & (1 | 8 | 16)) { // POLLIN, POLLERR, POLLHUP
          // No other process inherits this reader, so readiness cannot be
          // consumed by a child between poll and this non-waiting pipe read.
          return Number(library.symbols.read(fd, bytes, BigInt(bytes.length)));
        }
      }
      return 0;
    },
    close() {
      library.symbols.close(fd);
      library.close();
    },
  });
}
