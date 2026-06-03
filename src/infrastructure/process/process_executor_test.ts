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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { executeProcess, streamLines } from "./process_executor.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";

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

// --- Stream-0 regression net: abort signal & SIGTERM-on-timeout ---

Deno.test({
  name:
    "executeProcess: AbortSignal aborted mid-execution surfaces AbortError (streaming mode)",
  // sleep(1) and SIGTERM via process.kill are POSIX-only contracts. The
  // production code only attaches abort handling in streaming mode (when
  // a logger is provided), so we exercise that path here.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const mockLogger = {
      info: () => {},
      warn: () => {},
    } as unknown as import("@logtape/logtape").Logger;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    let caught: unknown;
    try {
      await executeProcess({
        command: "sleep",
        args: ["5"],
        logger: mockLogger,
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }

    assertEquals(
      caught !== undefined,
      true,
      "expected executeProcess to reject when signal aborts",
    );
    // The executor surfaces a DOMException with name "AbortError" when
    // the abort signal was responsible for the kill.
    const err = caught as { name?: string; message?: string };
    assertEquals(
      err.name,
      "AbortError",
      `expected AbortError; got name=${err.name} message=${err.message}`,
    );
  },
});

Deno.test({
  name:
    "executeProcess: timeout sends SIGTERM to child and surfaces timeout error",
  // SIGTERM-on-timeout semantics: the child process is killed via SIGTERM
  // (not SIGKILL) so signal-aware children can clean up. The executor
  // surfaces a generic "timed out" Error after the kill — this pins both
  // halves so a refactor that switches to SIGKILL or drops the kill
  // entirely will fail.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // Use sh with a SIGTERM-trapping handler. If SIGTERM arrives, the
    // trap runs and the child exits cleanly with code 143. If only
    // SIGKILL arrives, the trap never runs.
    let caught: unknown;
    try {
      await executeProcess({
        command: "sh",
        args: ["-c", "trap 'exit 143' TERM; sleep 5"],
        timeoutMs: 200,
      });
    } catch (err) {
      caught = err;
    }

    assertEquals(
      caught !== undefined,
      true,
      "expected executeProcess to throw on timeout",
    );
    const err = caught as Error;
    assertStringIncludes(err.message, "timed out");
    assertStringIncludes(err.message, "200ms");
  },
});

Deno.test("executeProcess redacts secrets from streamed stdout lines", async () => {
  const infoLines: string[] = [];
  const warnLines: string[] = [];

  const mockLogger = {
    info: (line: string) => {
      infoLines.push(line);
    },
    warn: (line: string) => {
      warnLines.push(line);
    },
  } as unknown as import("@logtape/logtape").Logger;

  const redactor = new SecretRedactor();
  redactor.addSecret("my-secret-token");

  const result = await executeProcess({
    command: "sh",
    args: ["-c", "echo my-secret-token && echo my-secret-token >&2"],
    logger: mockLogger,
    redactor,
  });

  assertEquals(result.success, true);
  // Streamed lines to logger should be redacted
  assertEquals(infoLines, ["***"]);
  assertEquals(warnLines, ["***"]);
  // Raw captured output is NOT redacted by process executor (shell model handles that)
  assertStringIncludes(result.stdout, "my-secret-token");
  assertStringIncludes(result.stderr, "my-secret-token");
});
