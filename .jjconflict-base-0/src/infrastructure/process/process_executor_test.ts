// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { executeProcess, streamLines } from "./process_executor.ts";

Deno.test("streamLines processes complete lines", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("line1\nline2\nline3"));
      controller.close();
    },
  });

  const lines: string[] = [];
  const result = await streamLines(stream, (line) => lines.push(line));

  assertEquals(lines, ["line1", "line2", "line3"]);
  assertEquals(result, "line1\nline2\nline3");
});

Deno.test("streamLines handles partial chunks", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("hel"));
      controller.enqueue(encoder.encode("lo\nwor"));
      controller.enqueue(encoder.encode("ld\n"));
      controller.close();
    },
  });

  const lines: string[] = [];
  const result = await streamLines(stream, (line) => lines.push(line));

  assertEquals(lines, ["hello", "world"]);
  assertEquals(result, "hello\nworld");
});

Deno.test("streamLines handles trailing content without newline", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("line1\npartial"));
      controller.close();
    },
  });

  const lines: string[] = [];
  await streamLines(stream, (line) => lines.push(line));

  assertEquals(lines, ["line1", "partial"]);
});

Deno.test("streamLines works without callback", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("hello\nworld"));
      controller.close();
    },
  });

  const result = await streamLines(stream);
  assertEquals(result, "hello\nworld");
});

Deno.test("executeProcess runs simple command", async () => {
  const result = await executeProcess({
    command: "echo",
    args: ["hello"],
  });

  assertEquals(result.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout.trim(), "hello");
  assertEquals(result.stderr, "");
  assertEquals(result.durationMs >= 0, true);
});

Deno.test("executeProcess captures exit code", async () => {
  const result = await executeProcess({
    command: "sh",
    args: ["-c", "exit 42"],
  });

  assertEquals(result.success, false);
  assertEquals(result.exitCode, 42);
});

Deno.test("executeProcess captures stderr", async () => {
  const result = await executeProcess({
    command: "sh",
    args: ["-c", "echo error >&2"],
  });

  assertEquals(result.success, true);
  assertStringIncludes(result.stderr, "error");
});

Deno.test("executeProcess supports env", async () => {
  const result = await executeProcess({
    command: "printenv",
    args: ["TEST_EXEC_VAR"],
    env: { TEST_EXEC_VAR: "hello_from_exec" },
  });

  assertEquals(result.success, true);
  assertEquals(result.stdout.trim(), "hello_from_exec");
});

Deno.test("executeProcess supports cwd", async () => {
  const result = await executeProcess({
    command: "pwd",
    cwd: "/tmp",
  });

  assertEquals(result.success, true);
  // On some systems /tmp may resolve to /private/tmp
  assertStringIncludes(result.stdout.trim(), "tmp");
});

Deno.test("executeProcess streams to logger", async () => {
  const infoLines: string[] = [];
  const warnLines: string[] = [];

  // Create a minimal mock logger
  const mockLogger = {
    info: (line: string) => {
      infoLines.push(line);
    },
    warn: (line: string) => {
      warnLines.push(line);
    },
  } as unknown as import("@logtape/logtape").Logger;

  const result = await executeProcess({
    command: "sh",
    args: ["-c", "echo stdout_line && echo stderr_line >&2"],
    logger: mockLogger,
  });

  assertEquals(result.success, true);
  assertEquals(infoLines, ["stdout_line"]);
  assertEquals(warnLines, ["stderr_line"]);
  assertStringIncludes(result.stdout, "stdout_line");
  assertStringIncludes(result.stderr, "stderr_line");
});

Deno.test("executeProcess handles timeout", async () => {
  try {
    await executeProcess({
      command: "sleep",
      args: ["10"],
      timeoutMs: 100,
    });
    throw new Error("Expected timeout error");
  } catch (error) {
    assertStringIncludes((error as Error).message, "timed out");
  }
});

Deno.test("executeProcess handles timeout with logger", async () => {
  const mockLogger = {
    info: () => {},
    warn: () => {},
  } as unknown as import("@logtape/logtape").Logger;

  try {
    await executeProcess({
      command: "sleep",
      args: ["10"],
      timeoutMs: 100,
      logger: mockLogger,
    });
    throw new Error("Expected timeout error");
  } catch (error) {
    assertStringIncludes((error as Error).message, "timed out");
  }
});
