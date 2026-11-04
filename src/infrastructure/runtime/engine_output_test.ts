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
  createEngineOutput,
  openEngineOutput,
  parseEngineOutputTarget,
} from "./engine_output.ts";

Deno.test({
  name:
    "openEngineOutput: Unix native pipe becomes close-on-exec before writing",
  ignore: Deno.build.os === "windows",
  async fn() {
    const native = Deno.dlopen(
      Deno.build.os === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
      {
        pipe: { parameters: ["buffer"], result: "i32" },
        fcntl: { parameters: ["i32", "i32"], result: "i32" },
        read: { parameters: ["i32", "buffer", "usize"], result: "isize" },
        close: { parameters: ["i32"], result: "i32" },
      } as const,
    );
    const descriptors = new Int32Array(2);
    let output: ReturnType<typeof openEngineOutput> | undefined;
    let ownsRead = false;
    let ownsWrite = false;
    try {
      assertEquals(native.symbols.pipe(descriptors), 0);
      ownsRead = ownsWrite = true;
      assertEquals(native.symbols.fcntl(descriptors[1], 1) & 1, 0);
      // openEngineOutput owns the descriptor from this point, including errors.
      ownsWrite = false;
      output = openEngineOutput("--output-fd", String(descriptors[1]));
      assertEquals(native.symbols.fcntl(descriptors[1], 1) & 1, 1);
      const writer = output.stream.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      writer.releaseLock();
      const bytes = new Uint8Array(3);
      assertEquals(Number(native.symbols.read(descriptors[0], bytes, 3n)), 3);
      assertEquals(bytes, new Uint8Array([1, 2, 3]));
      await output.dispose();
      assertEquals(
        Number(native.symbols.read(descriptors[0], new Uint8Array(1), 1n)),
        0,
      );
    } finally {
      await output?.dispose();
      if (ownsRead) native.symbols.close(descriptors[0]);
      if (ownsWrite) native.symbols.close(descriptors[1]);
      native.close();
    }
  },
});

Deno.test("parseEngineOutputTarget: private descriptors match the target platform", () => {
  assertEquals(parseEngineOutputTarget("--output-fd", "3", "linux"), 3n);
  assertEquals(parseEngineOutputTarget("--output-fd", "17", "darwin"), 17n);
  assertEquals(
    parseEngineOutputTarget("--output-handle", "9007199254740993", "windows"),
    9007199254740993n,
  );
  for (const value of ["", "-1", "1.5", "0x3", "1e3", " 3", "3 "]) {
    assertThrows(() => parseEngineOutputTarget("--output-fd", value, "linux"));
  }
  for (const value of ["0", "1", "2", "2147483648"]) {
    assertThrows(() => parseEngineOutputTarget("--output-fd", value, "linux"));
  }
  for (const value of ["0", "18446744073709551615", "18446744073709551616"]) {
    assertThrows(() =>
      parseEngineOutputTarget("--output-handle", value, "windows")
    );
  }
  assertThrows(() => parseEngineOutputTarget("--output-fd", "3", "windows"));
  assertThrows(() => parseEngineOutputTarget("--output-handle", "3", "linux"));
});

Deno.test("createEngineOutput: partial native writes preserve exact frame bytes and close once", async () => {
  const actual: number[] = [];
  let closed = 0;
  const output = createEngineOutput({
    write(bytes) {
      const count = Math.min(2, bytes.length);
      actual.push(...bytes.subarray(0, count));
      return Promise.resolve(count);
    },
    close() {
      closed++;
    },
  });
  const writer = output.stream.getWriter();
  await writer.write(new Uint8Array([0, 1, 2, 3, 4]));
  await writer.write(new Uint8Array([5, 6]));
  await writer.close();
  await output.dispose();
  assertEquals(actual, [0, 1, 2, 3, 4, 5, 6]);
  assertEquals(closed, 1);
});

Deno.test("createEngineOutput: disposal waits for the outstanding native write", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<number>();
  let closed = false;
  const output = createEngineOutput({
    write() {
      entered.resolve();
      return release.promise;
    },
    close() {
      closed = true;
    },
  });
  const writer = output.stream.getWriter();
  const writing = writer.write(new Uint8Array([1]));
  await entered.promise;
  const disposing = output.dispose();
  assertEquals(closed, false);
  release.resolve(1);
  await writing;
  await disposing;
  assertEquals(closed, true);
  writer.releaseLock();
});

Deno.test("createEngineOutput: disposal refuses queued writes before closing native handles", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<number>();
  let writes = 0;
  let closes = 0;
  const output = createEngineOutput({
    write() {
      writes++;
      entered.resolve();
      return release.promise;
    },
    close() {
      closes++;
    },
  });
  const writer = output.stream.getWriter();
  const first = writer.write(new Uint8Array([1]));
  await entered.promise;
  const second = assertRejects(
    () => writer.write(new Uint8Array([2])),
    Error,
    "Engine output pipe is closed",
  );
  const disposing = output.dispose();
  assertEquals(closes, 0);
  release.resolve(1);
  await Promise.all([first, second, disposing]);
  assertEquals(writes, 1);
  assertEquals(closes, 1);
  writer.releaseLock();
});

Deno.test("createEngineOutput: failed or impossible writes fail safely and release the pipe", async () => {
  for (const result of [-1, 0, 2, 0.5, NaN, "throw"] as const) {
    let closed = false;
    const output = createEngineOutput({
      write() {
        if (result === "throw") {
          return Promise.reject(new Error("secret-canary"));
        }
        return Promise.resolve(result);
      },
      close() {
        closed = true;
      },
    });
    const writer = output.stream.getWriter();
    const error = await assertRejects(
      () => writer.write(new Uint8Array([1])),
      Error,
      "Engine output pipe write failed",
    );
    assertEquals(error.message.includes("secret-canary"), false);
    await output.dispose();
    assertEquals(closed, true);
    writer.releaseLock();
  }
});
