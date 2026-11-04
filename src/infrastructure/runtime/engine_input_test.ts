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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createEngineInput,
  openEngineInput,
  parseEngineInputTarget,
} from "./engine_input.ts";

Deno.test("parseEngineInputTarget: private descriptors match the target platform and never stdin", () => {
  assertEquals(parseEngineInputTarget("--input-fd", "3", "linux"), 3n);
  assertEquals(parseEngineInputTarget("--input-fd", "17", "darwin"), 17n);
  assertEquals(
    parseEngineInputTarget("--input-handle", "9007199254740993", "windows"),
    9007199254740993n,
  );
  for (const value of ["", "-1", "1.5", "0x3", "1e3", " 3", "3 "]) {
    assertThrows(() => parseEngineInputTarget("--input-fd", value, "linux"));
  }
  for (const value of ["0", "1", "2", "2147483648"]) {
    assertThrows(() => parseEngineInputTarget("--input-fd", value, "linux"));
  }
  for (const value of ["0", "18446744073709551615", "18446744073709551616"]) {
    assertThrows(() =>
      parseEngineInputTarget("--input-handle", value, "windows")
    );
  }
  assertThrows(() => parseEngineInputTarget("--input-fd", "3", "windows"));
  assertThrows(() => parseEngineInputTarget("--input-handle", "3", "linux"));
  assertThrows(() => parseEngineInputTarget("--output-fd", "3", "linux"));
});

Deno.test("createEngineInput: reads only on demand, preserves exact bytes and closes once at EOF", async () => {
  let reads = 0;
  let closes = 0;
  const input = createEngineInput({
    read(bytes) {
      reads++;
      if (reads > 1) return Promise.resolve(0);
      bytes.set([0, 1, 2]);
      return Promise.resolve(3);
    },
    close() {
      closes++;
    },
  });
  assertEquals(reads, 0);
  const reader = input.stream.getReader();
  assertEquals(await reader.read(), {
    done: false,
    value: new Uint8Array([0, 1, 2]),
  });
  assertEquals(reads, 1);
  assertEquals(await reader.read(), { done: true, value: undefined });
  reader.releaseLock();
  await input.dispose();
  await input.dispose();
  assertEquals(reads, 2);
  assertEquals(closes, 1);
});

Deno.test("createEngineInput: cancellation aborts the reader and joins native work before closing", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const pending = Promise.withResolvers<number>();
  let closes = 0;
  const input = createEngineInput({
    read(_bytes, signal) {
      entered.resolve(signal);
      return pending.promise;
    },
    close() {
      closes++;
    },
  });
  const reader = input.stream.getReader();
  const reading = reader.read();
  const signal = await entered.promise;
  const disposing = input.dispose();
  assertEquals(signal.aborted, true);
  assertEquals(closes, 0);
  // Even a late native payload must not be delivered after disposal.
  pending.resolve(3);
  await disposing;
  assertEquals(await reading, { done: true, value: undefined });
  reader.releaseLock();
  await input.dispose();
  assertEquals(closes, 1);
});

Deno.test("createEngineInput: failed and impossible reads are sanitized and release ownership", async () => {
  for (const result of [-1, 65537, 0.5, NaN, "throw"] as const) {
    let closes = 0;
    const input = createEngineInput({
      read() {
        return result === "throw"
          ? Promise.reject(new Error("PRIVATE_INPUT_CANARY"))
          : Promise.resolve(result);
      },
      close() {
        closes++;
      },
    });
    const reader = input.stream.getReader();
    const error = await assertRejects(
      () => reader.read(),
      Error,
      "Engine input pipe read failed",
    );
    assertEquals(error.message.includes("PRIVATE_INPUT_CANARY"), false);
    reader.releaseLock();
    await input.dispose();
    assertEquals(closes, 1);
  }
});

for (const ending of ["EOF", "cancellation"] as const) {
  Deno.test({
    name: `openEngineInput: Unix pipe is close-on-exec and settles ${ending}`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const native = Deno.dlopen(
        Deno.build.os === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
        {
          pipe: { parameters: ["buffer"], result: "i32" },
          fcntl: { parameters: ["i32", "i32"], result: "i32" },
          write: { parameters: ["i32", "buffer", "usize"], result: "isize" },
          close: { parameters: ["i32"], result: "i32" },
        } as const,
      );
      const descriptors = new Int32Array(2);
      let input: ReturnType<typeof openEngineInput> | undefined;
      let ownsRead = false;
      let ownsWrite = false;
      try {
        assertEquals(native.symbols.pipe(descriptors), 0);
        ownsRead = ownsWrite = true;
        assertEquals(native.symbols.fcntl(descriptors[0], 1) & 1, 0);
        ownsRead = false; // openEngineInput assumes ownership, including failure.
        input = openEngineInput("--input-fd", String(descriptors[0]));
        assertEquals(native.symbols.fcntl(descriptors[0], 1) & 1, 1);
        const reader = input.stream.getReader();
        const payload = new Uint8Array([3, 2, 1]);
        assertEquals(
          Number(native.symbols.write(descriptors[1], payload, 3n)),
          3,
        );
        if (ending === "EOF") {
          native.symbols.close(descriptors[1]);
          ownsWrite = false;
        }
        // HUP can arrive together with buffered bytes: drain those before EOF.
        assertEquals((await reader.read()).value, payload);
        const endingRead = reader.read();
        if (ending === "cancellation") {
          await input.dispose();
        }
        assertEquals(await endingRead, { done: true, value: undefined });
        reader.releaseLock();
        await input.dispose();
        assertEquals(native.symbols.fcntl(descriptors[0], 1), -1);
      } finally {
        await input?.dispose();
        if (ownsRead) native.symbols.close(descriptors[0]);
        if (ownsWrite) native.symbols.close(descriptors[1]);
        native.close();
      }
    },
  });

  Deno.test({
    name:
      `openEngineInput: Windows pipe is non-inheritable and settles ${ending}`,
    ignore: Deno.build.os !== "windows",
    async fn() {
      const native = Deno.dlopen(
        "kernel32.dll",
        {
          CreatePipe: {
            parameters: ["buffer", "buffer", "pointer", "u32"],
            result: "i32",
          },
          SetHandleInformation: {
            parameters: ["pointer", "u32", "u32"],
            result: "i32",
          },
          GetHandleInformation: {
            parameters: ["pointer", "buffer"],
            result: "i32",
          },
          WriteFile: {
            parameters: ["pointer", "buffer", "u32", "buffer", "pointer"],
            result: "i32",
          },
          CloseHandle: { parameters: ["pointer"], result: "i32" },
        } as const,
      );
      const readHandle = new BigUint64Array(1);
      const writeHandle = new BigUint64Array(1);
      let input: ReturnType<typeof openEngineInput> | undefined;
      let ownsRead = false;
      let ownsWrite = false;
      try {
        assertEquals(
          native.symbols.CreatePipe(readHandle, writeHandle, null, 0),
          1,
        );
        ownsRead = ownsWrite = true;
        const read = Deno.UnsafePointer.create(readHandle[0]);
        const write = Deno.UnsafePointer.create(writeHandle[0]);
        assertEquals(native.symbols.SetHandleInformation(read, 1, 1), 1);
        ownsRead = false;
        input = openEngineInput("--input-handle", String(readHandle[0]));
        const flags = new Uint32Array(1);
        assertEquals(native.symbols.GetHandleInformation(read, flags), 1);
        assertEquals(flags[0] & 1, 0);
        const reader = input.stream.getReader();
        const payload = new Uint8Array([3, 2, 1]);
        const written = new Uint32Array(1);
        assertEquals(
          native.symbols.WriteFile(write, payload, 3, written, null),
          1,
        );
        assertEquals(written[0], 3);
        if (ending === "EOF") {
          native.symbols.CloseHandle(write);
          ownsWrite = false;
        }
        assertEquals((await reader.read()).value, payload);
        const endingRead = reader.read();
        if (ending === "cancellation") {
          await input.dispose();
        }
        assertEquals(await endingRead, { done: true, value: undefined });
        reader.releaseLock();
        await input.dispose();
        assertEquals(native.symbols.GetHandleInformation(read, flags), 0);
      } finally {
        await input?.dispose();
        if (ownsRead) {
          native.symbols.CloseHandle(Deno.UnsafePointer.create(readHandle[0]));
        }
        if (ownsWrite) {
          native.symbols.CloseHandle(Deno.UnsafePointer.create(writeHandle[0]));
        }
        native.close();
      }
    },
  });
}
