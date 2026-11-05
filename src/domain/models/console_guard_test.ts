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
import {
  setConsoleGuardStderrWriter,
  unguardedConsole,
  withConsoleGuard,
} from "./console_guard.ts";
import { runFileSink } from "../../infrastructure/logging/run_file_sink.ts";
import { SecretRedactor } from "../secrets/mod.ts";

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
  assertStringIncludes(logs[0], "log msg");
  assertStringIncludes(logs[1], "info msg");
  assertStringIncludes(logs[2], "debug msg");
  assertStringIncludes(logs[3], "warn msg");
  assertStringIncludes(logs[4], "error msg");
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
  assertStringIncludes(logs[0], "circular:");
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

Deno.test("withConsoleGuard: a line logged under concurrent guards reaches stderr once", async () => {
  const stderr: string[] = [];
  setConsoleGuardStderrWriter((line) => stderr.push(line));
  const logsA: string[] = [];
  const logsB: string[] = [];
  const gateA = Promise.withResolvers<void>();
  const gateB = Promise.withResolvers<void>();
  const bothActive = Promise.withResolvers<void>();

  try {
    const guardA = withConsoleGuard(() => gateA.promise, logsA, {
      jsonMode: true,
    });
    const guardB = withConsoleGuard(
      async () => {
        bothActive.resolve();
        await gateB.promise;
      },
      logsB,
      { jsonMode: true },
    );
    await bothActive.promise;

    console.log("shared line");

    gateB.resolve();
    await guardB;
    gateA.resolve();
    await guardA;

    assertEquals(stderr, ["shared line"]);
    assertEquals(logsA, ["shared line"]);
    assertEquals(logsB, ["shared line"]);
  } finally {
    setConsoleGuardStderrWriter(undefined);
  }
});

Deno.test("unguardedConsole: bypasses capture while a guard is active", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => stdout.push(msg);
  console.error = (msg: string) => stderr.push(msg);
  const captured: string[] = [];
  setConsoleGuardStderrWriter((line) => captured.push(line));
  const logs: string[] = [];

  try {
    await withConsoleGuard(
      () => {
        unguardedConsole.log("to stdout");
        unguardedConsole.error("to stderr");
      },
      logs,
      { jsonMode: true },
    );

    assertEquals(logs, []);
    assertEquals(captured, []);
    assertEquals(stdout, ["to stdout"]);
    assertEquals(stderr, ["to stderr"]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    setConsoleGuardStderrWriter(undefined);
  }
});

Deno.test("unguardedConsole: uses the current console when no guard is active", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => stdout.push(msg);
  console.error = (msg: string) => stderr.push(msg);

  try {
    unguardedConsole.log("out");
    unguardedConsole.error("err");

    assertEquals(stdout, ["out"]);
    assertEquals(stderr, ["err"]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

Deno.test("withConsoleGuard: restores the console in place before the first guard", async () => {
  const originalLog = console.log;
  const stub = (..._args: unknown[]) => {};
  console.log = stub;
  setConsoleGuardStderrWriter(() => {});

  try {
    await withConsoleGuard(
      () => {
        console.log("captured");
      },
      [],
      { jsonMode: true },
    );

    assertEquals(console.log, stub);
  } finally {
    console.log = originalLog;
    setConsoleGuardStderrWriter(undefined);
  }
});

Deno.test("withConsoleGuard: masks an active redactor's secrets on stderr but keeps the captured line raw (swamp-club#3526)", async () => {
  const redactor = new SecretRedactor();
  redactor.addSecret("guarded-secret-3526");
  const handle = runFileSink.registerRedactor(redactor);
  const stderr: string[] = [];
  setConsoleGuardStderrWriter((line) => stderr.push(line));
  const logs: string[] = [];

  try {
    await withConsoleGuard(
      () => {
        console.log("token guarded-secret-3526 seen");
      },
      logs,
      { jsonMode: true },
    );

    // The writer, default or injected, only ever sees the scrubbed line; the
    // captured copy is raw because its consumers redact it themselves.
    assertEquals(stderr, ["token *** seen"]);
    assertEquals(logs, ["token guarded-secret-3526 seen"]);
  } finally {
    setConsoleGuardStderrWriter(undefined);
    runFileSink.unregisterRedactor(handle);
  }
});

Deno.test("withConsoleGuard: console.dir masks a secret learned during execution and restores the original method", async () => {
  const redactor = new SecretRedactor();
  const handle = runFileSink.registerRedactor(redactor);
  const originalDir = console.dir;
  const stderr: string[] = [];
  const logs: string[] = [];
  setConsoleGuardStderrWriter((line) => stderr.push(line));
  const secret = 'learned"secret\\value\n'.repeat(20);
  try {
    await withConsoleGuard(
      () => {
        redactor.addSecret(secret);
        console.dir({ token: secret }, { strAbbreviateSize: 8 });
      },
      logs,
      { jsonMode: true },
    );

    assertEquals(stderr.map((line) => line.replace(/\s/g, "")), [
      "{token:'***'}",
    ]);
    assertEquals(logs, [
      Deno.inspect({ token: secret }, {
        strAbbreviateSize: Infinity,
        breakLength: Infinity,
      }),
    ]);
    assertEquals(console.dir, originalDir);
  } finally {
    setConsoleGuardStderrWriter(undefined);
    runFileSink.unregisterRedactor(handle);
  }
});

Deno.test("withConsoleGuard: in log mode masks an active redactor's secrets on each console stream and captures nothing", async () => {
  const secret = `log-mode-secret-${crypto.randomUUID()}`;
  const redactor = new SecretRedactor();
  redactor.addSecret(secret);
  const handle = runFileSink.registerRedactor(redactor);
  const originalLog = console.log;
  const originalError = console.error;
  const originalDir = console.dir;
  const stdout: unknown[][] = [];
  const stderr: unknown[][] = [];
  const logStub = (...args: unknown[]) => stdout.push(args);
  const errorStub = (...args: unknown[]) => stderr.push(args);
  console.log = logStub;
  console.error = errorStub;
  const logs: string[] = [];

  try {
    await withConsoleGuard(
      () => {
        console.log("console:", secret);
        console.error(`failed with ${secret}`);
        console.dir({ token: secret });
      },
      logs,
      { jsonMode: false },
    );

    assertEquals(stdout, [["console: ***"], ['{ token: "***" }']]);
    assertEquals(stderr, [["failed with ***"]]);
    assertEquals(logs, []);
    assertEquals(console.log, logStub);
    assertEquals(console.error, errorStub);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.dir = originalDir;
    runFileSink.unregisterRedactor(handle);
  }
});

Deno.test("withConsoleGuard: in log mode forwards the original arguments when no secret is active", async () => {
  const originalLog = console.log;
  const calls: unknown[][] = [];
  console.log = (...args: unknown[]) => calls.push(args);
  const value = { nested: [1, 2] };

  try {
    await withConsoleGuard(
      () => {
        console.log("%s value", "formatted", value);
      },
      [],
      { jsonMode: false },
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0][0], "%s value");
    assertEquals(calls[0][2] === value, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("withConsoleGuard: in log mode restores the console after a throw", async () => {
  const originalLog = console.log;
  const stub = (..._args: unknown[]) => {};
  console.log = stub;

  try {
    let thrown = false;
    try {
      await withConsoleGuard(
        () => {
          throw new Error("boom");
        },
        [],
        { jsonMode: false },
      );
    } catch {
      thrown = true;
    }

    assertEquals(thrown, true);
    assertEquals(console.log, stub);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("withConsoleGuard: a JSON-mode guard keeps capturing while a log-mode guard is active", async () => {
  const stderr: string[] = [];
  setConsoleGuardStderrWriter((line) => stderr.push(line));
  const jsonLogs: string[] = [];
  const logModeLogs: string[] = [];
  const logModeEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  try {
    const logMode = withConsoleGuard(
      async () => {
        logModeEntered.resolve();
        await release.promise;
      },
      logModeLogs,
      { jsonMode: false },
    );
    await logModeEntered.promise;
    await withConsoleGuard(
      () => {
        console.log("from json mode");
      },
      jsonLogs,
      { jsonMode: true },
    );
    release.resolve();
    await logMode;

    assertEquals(jsonLogs, ["from json mode"]);
    assertEquals(logModeLogs, []);
    assertEquals(stderr, ["from json mode"]);
  } finally {
    setConsoleGuardStderrWriter(undefined);
  }
});

Deno.test("withConsoleGuard: in log mode console.table, trace and assert print masked lines on their usual stream", async () => {
  const secret = `table-secret-${crypto.randomUUID()}`;
  const redactor = new SecretRedactor();
  redactor.addSecret(secret);
  const handle = runFileSink.registerRedactor(redactor);
  const original = {
    log: console.log,
    error: console.error,
    table: console.table,
    trace: console.trace,
    assert: console.assert,
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));

  try {
    await withConsoleGuard(
      () => {
        console.table([{ token: secret }]);
        console.trace("tracing", secret);
        console.assert(true, `passing ${secret}`);
        console.assert(false, `failing ${secret}`);
      },
      [],
      { jsonMode: false },
    );

    const output = [...stdout, ...stderr].join("\n");
    assertEquals(output.includes(secret), false, output);
    assertEquals(stdout.length, 1);
    assertStringIncludes(stdout[0], 'token: "***"');
    assertEquals(stderr.length, 2);
    assertStringIncludes(stderr[0], "Trace: tracing ***\n");
    assertStringIncludes(stderr[0], "console_guard_test.ts");
    assertEquals(stderr[0].includes("renderLine"), false, stderr[0]);
    assertEquals(stderr[1], "Assertion failed: failing ***");
    assertEquals(console.table, original.table);
    assertEquals(console.trace, original.trace);
    assertEquals(console.assert, original.assert);
  } finally {
    console.log = original.log;
    console.error = original.error;
    runFileSink.unregisterRedactor(handle);
  }
});

Deno.test("withConsoleGuard: in log mode an error, a map and a set keep their contents and are masked", async () => {
  const secret = `error-secret-${crypto.randomUUID()}`;
  const redactor = new SecretRedactor();
  redactor.addSecret(secret);
  const handle = runFileSink.registerRedactor(redactor);
  const original = { log: console.log, error: console.error };
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));

  try {
    await withConsoleGuard(
      () => {
        console.error("failed:", new Error(`boom ${secret}`));
        console.log(new Map([["token", secret]]), new Set([secret]));
      },
      [],
      { jsonMode: false },
    );

    const output = [...stdout, ...stderr].join("\n");
    assertEquals(output.includes(secret), false, output);
    assertEquals(stderr.length, 1);
    assertStringIncludes(stderr[0], "failed: Error: boom ***\n");
    assertStringIncludes(stderr[0], "console_guard_test.ts");
    assertEquals(stdout, ['Map(1) { "token" => "***" } Set(1) { "***" }']);
  } finally {
    console.log = original.log;
    console.error = original.error;
    runFileSink.unregisterRedactor(handle);
  }
});

Deno.test("withConsoleGuard: a patched console.table or trace held past the last guard still prints masked", async () => {
  const secret = `held-secret-${crypto.randomUUID()}`;
  const original = { log: console.log, error: console.error };
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  let heldTable: typeof console.table = console.table;
  let heldTrace: typeof console.trace = console.trace;
  const redactor = new SecretRedactor();
  redactor.addSecret(secret);
  let handle: ReturnType<typeof runFileSink.registerRedactor> | undefined;

  try {
    await withConsoleGuard(
      () => {
        heldTable = console.table;
        heldTrace = console.trace;
      },
      [],
      { jsonMode: false },
    );
    handle = runFileSink.registerRedactor(redactor);

    heldTable({ token: secret });
    heldTrace(secret);

    assertEquals(stdout.length, 1);
    assertStringIncludes(stdout[0], 'token: "***"');
    assertEquals(stderr.length, 1);
    assertStringIncludes(stderr[0], "Trace: ***\n");
  } finally {
    console.log = original.log;
    console.error = original.error;
    if (handle !== undefined) runFileSink.unregisterRedactor(handle);
  }
});

Deno.test("withConsoleGuard: in JSON mode console.table, trace and failing assert are captured and reach stderr masked", async () => {
  const secret = `json-table-secret-${crypto.randomUUID()}`;
  const redactor = new SecretRedactor();
  redactor.addSecret(secret);
  const handle = runFileSink.registerRedactor(redactor);
  const stderr: string[] = [];
  setConsoleGuardStderrWriter((line) => stderr.push(line));
  const logs: string[] = [];

  try {
    await withConsoleGuard(
      () => {
        console.table({ token: secret });
        console.trace(secret);
        console.assert(true, "never printed");
        console.assert(false);
      },
      logs,
      { jsonMode: true },
    );

    assertEquals(logs.length, 3);
    assertEquals(stderr.length, 3);
    assertEquals(stderr.join("\n").includes(secret), false);
    assertStringIncludes(logs[0], secret);
    assertStringIncludes(stderr[1], "Trace: ***");
    assertEquals(logs[2], "Assertion failed");
  } finally {
    setConsoleGuardStderrWriter(undefined);
    runFileSink.unregisterRedactor(handle);
  }
});
