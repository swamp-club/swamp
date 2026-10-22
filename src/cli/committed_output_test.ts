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

import { assertEquals } from "@std/assert";
import {
  beginOutcome,
  holdFromOutcome,
  openOutputHold,
  writeHeldOutput,
} from "./committed_output.ts";
import {
  setConsoleGuardStderrWriter,
  unguardedConsole,
  withConsoleGuard,
} from "../domain/models/console_guard.ts";

/**
 * Runs `fn` with the stdout console methods recording into the returned
 * list, as `method:text`, and restores them afterwards.
 */
async function recordingStdout(
  fn: (written: string[]) => void | Promise<void>,
): Promise<string[]> {
  const written: string[] = [];
  const saved = { log: console.log, info: console.info, debug: console.debug };
  for (const method of ["log", "info", "debug"] as const) {
    console[method] = (...args: unknown[]) => {
      written.push(`${method}:${args.join(" ")}`);
    };
  }
  try {
    await fn(written);
  } finally {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
  }
  return written;
}

Deno.test("openOutputHold: a held root writes what it held, in order, once it committed", async () => {
  await recordingStdout((written) => {
    const hold = openOutputHold("held");
    console.log("first");
    console.info("second");
    console.debug("third");
    assertEquals(written, [], "nothing reaches stdout before the commit");
    hold.end(true);
    assertEquals(written, ["log:first", "info:second", "debug:third"]);
    console.log("after");
    assertEquals(written.at(-1), "log:after", "the console is restored");
  });
});

Deno.test("openOutputHold: a root that did not commit drops what it held", async () => {
  await recordingStdout((written) => {
    const hold = openOutputHold("held");
    console.log('{"status": "succeeded"}');
    hold.end(false);
    assertEquals(written, []);
    console.log("after");
    assertEquals(written, ["log:after"]);
  });
});

Deno.test("openOutputHold: stderr is never held", async () => {
  const errors: string[] = [];
  const savedError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    await recordingStdout(() => {
      const hold = openOutputHold("held");
      console.error("a warning");
      assertEquals(errors, ["a warning"]);
      hold.end(false);
    });
  } finally {
    console.error = savedError;
  }
});

Deno.test("openOutputHold: a root opened inside another joins the outer hold", async () => {
  await recordingStdout((written) => {
    const outer = openOutputHold("held");
    const inner = openOutputHold("live-until-outcome");
    console.log("inner result");
    inner.end(true);
    assertEquals(written, [], "the inner root's end writes nothing");
    outer.end(true);
    assertEquals(written, ["log:inner result"]);
  });
});

Deno.test("openOutputHold: live until the outcome streams progress, then holds the result and what follows", async () => {
  await recordingStdout((written) => {
    const hold = openOutputHold("live-until-outcome");
    console.log("step started");
    assertEquals(written, ["log:step started"]);
    beginOutcome();
    console.log("Completed");
    console.log("Cleanup");
    assertEquals(written, ["log:step started"]);
    hold.end(false);
    assertEquals(written, ["log:step started"]);
  });
});

Deno.test("holdFromOutcome: a terminal handler starts holding before it renders; others do not", async () => {
  await recordingStdout((written) => {
    const hold = openOutputHold("live-until-outcome");
    const handlers = holdFromOutcome({
      executing: () => console.log("executing"),
      completed: () => console.log("completed"),
    });
    handlers.executing();
    handlers.completed();
    assertEquals(written, ["log:executing"]);
    hold.end(true);
    assertEquals(written, ["log:executing", "log:completed"]);
  });
});

Deno.test("writeHeldOutput: a prompt shows what was held before it, and holding goes on", async () => {
  await recordingStdout((written) => {
    const hold = openOutputHold("held");
    console.log("preview");
    writeHeldOutput();
    assertEquals(written, ["log:preview"]);
    console.log("result");
    assertEquals(written, ["log:preview"]);
    hold.end(false);
    assertEquals(written, ["log:preview"]);
  });
});

Deno.test("openOutputHold: inside a held root, a console guard's renderer output is held and a method's console output still goes to stderr", async () => {
  const stderr: string[] = [];
  setConsoleGuardStderrWriter((line) => stderr.push(line));
  try {
    await recordingStdout(async (written) => {
      const hold = openOutputHold("held");
      const logs: string[] = [];
      await withConsoleGuard(
        () => {
          console.log("from the method");
          unguardedConsole.log('{"status": "succeeded"}');
        },
        logs,
        { jsonMode: true },
      );
      assertEquals(stderr, ["from the method"]);
      assertEquals(written, [], "the renderer's document waits");
      hold.end(true);
      assertEquals(written, ['log:{"status": "succeeded"}']);
    });
  } finally {
    setConsoleGuardStderrWriter(undefined);
  }
});
