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
import { withConsoleGuard } from "./console_guard.ts";

Deno.test("withConsoleGuard: captures console.log into logs array", async () => {
  const logs: string[] = [];

  await withConsoleGuard(
    () => {
      console.log("hello from extension");
    },
    logs,
    { jsonMode: true },
  );

  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "hello from extension");
  assertStringIncludes(logs[0], "[log]");
});

Deno.test("withConsoleGuard: captures all console methods", async () => {
  const logs: string[] = [];

  await withConsoleGuard(
    () => {
      console.log("log msg");
      console.info("info msg");
      console.debug("debug msg");
      console.warn("warn msg");
      console.error("error msg");
    },
    logs,
    { jsonMode: true },
  );

  assertEquals(logs.length, 5);
  assertStringIncludes(logs[0], "[log] log msg");
  assertStringIncludes(logs[1], "[info] info msg");
  assertStringIncludes(logs[2], "[debug] debug msg");
  assertStringIncludes(logs[3], "[warn] warn msg");
  assertStringIncludes(logs[4], "[error] error msg");
});

Deno.test("withConsoleGuard: restores console after normal completion", async () => {
  const originalLog = console.log;
  const logs: string[] = [];

  await withConsoleGuard(
    () => {
      // inside guard
    },
    logs,
    { jsonMode: true },
  );

  assertEquals(console.log, originalLog);
});

Deno.test("withConsoleGuard: restores console after throw", async () => {
  const originalLog = console.log;
  const logs: string[] = [];

  try {
    await withConsoleGuard(
      () => {
        console.log("before throw");
        throw new Error("extension failure");
      },
      logs,
      { jsonMode: true },
    );
  } catch {
    // expected
  }

  assertEquals(console.log, originalLog);
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "before throw");
});

Deno.test("withConsoleGuard: returns the function result", async () => {
  const logs: string[] = [];

  const result = await withConsoleGuard(
    () => {
      console.log("working");
      return 42;
    },
    logs,
    { jsonMode: true },
  );

  assertEquals(result, 42);
});

Deno.test("withConsoleGuard: handles non-string arguments", async () => {
  const logs: string[] = [];

  await withConsoleGuard(
    () => {
      console.log("count:", 42, { key: "value" });
    },
    logs,
    { jsonMode: true },
  );

  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "count:");
  assertStringIncludes(logs[0], "42");
  assertStringIncludes(logs[0], '"key"');
});

Deno.test("withConsoleGuard: handles circular objects without throwing", async () => {
  const logs: string[] = [];

  await withConsoleGuard(
    () => {
      const obj: Record<string, unknown> = { name: "test" };
      obj.self = obj;
      console.log("circular:", obj);
    },
    logs,
    { jsonMode: true },
  );

  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "[log] circular:");
  assertStringIncludes(logs[0], "name");
});

Deno.test("withConsoleGuard: handles undefined and function arguments", async () => {
  const logs: string[] = [];

  await withConsoleGuard(
    () => {
      console.log("undef:", undefined, "fn:", () => {});
    },
    logs,
    { jsonMode: true },
  );

  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "undef:");
  assertStringIncludes(logs[0], "undefined");
});

Deno.test("withConsoleGuard: concurrent guards restore console after both complete", async () => {
  const originalLog = console.log;
  const logsA: string[] = [];
  const logsB: string[] = [];

  await Promise.all([
    withConsoleGuard(
      () => {
        console.log("from A");
      },
      logsA,
      { jsonMode: true },
    ),
    withConsoleGuard(
      () => {
        console.log("from B");
      },
      logsB,
      { jsonMode: true },
    ),
  ]);

  assertEquals(console.log, originalLog);
});

Deno.test("withConsoleGuard: skips capture in non-JSON mode", async () => {
  const logs: string[] = [];

  const result = await withConsoleGuard(
    () => {
      return 99;
    },
    logs,
    { jsonMode: false },
  );

  assertEquals(result, 99);
  assertEquals(logs.length, 0);
});
