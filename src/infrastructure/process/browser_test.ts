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

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { type BrowserLauncherProcess, openBrowser } from "./browser.ts";
import { UserError } from "../../domain/errors.ts";

// We can't test actual browser opening in CI, but we can verify the
// function exists and is importable with the expected signature.
Deno.test("openBrowser - is an async function", () => {
  assertExists(openBrowser);
  assertEquals(typeof openBrowser, "function");
});

const URL = "https://swamp-club.com/device?user_code=ABCD1234";

function fakeLauncher(
  status: Promise<Deno.CommandStatus> | (() => never),
) {
  const calls: { command: string; options: Deno.CommandOptions }[] = [];
  let unrefCalls = 0;
  const spawn = (
    command: string,
    options: Deno.CommandOptions,
  ): BrowserLauncherProcess => {
    calls.push({ command, options });
    if (typeof status === "function") status();
    return {
      status: status as Promise<Deno.CommandStatus>,
      unref: () => {
        unrefCalls++;
      },
    };
  };
  return { spawn, calls, unrefCalls: () => unrefCalls };
}

const exited = (code: number): Promise<Deno.CommandStatus> =>
  Promise.resolve({ success: code === 0, code, signal: null });

Deno.test("openBrowser: resolves when the launcher exits successfully", async () => {
  const launcher = fakeLauncher(exited(0));

  await openBrowser(URL, { os: "linux", spawn: launcher.spawn });

  assertEquals(launcher.calls.length, 1);
  assertEquals(launcher.unrefCalls(), 0);
});

Deno.test("openBrowser: runs xdg-open on linux with null stdio", async () => {
  const launcher = fakeLauncher(exited(0));

  await openBrowser(URL, { os: "linux", spawn: launcher.spawn });

  assertEquals(launcher.calls[0].command, "xdg-open");
  assertEquals(launcher.calls[0].options, {
    args: [URL],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
});

Deno.test("openBrowser: uses open on darwin and cmd start on windows", async () => {
  const mac = fakeLauncher(exited(0));
  await openBrowser(URL, { os: "darwin", spawn: mac.spawn });
  assertEquals(mac.calls[0].command, "open");
  assertEquals(mac.calls[0].options.args, [URL]);

  const windows = fakeLauncher(exited(0));
  await openBrowser(URL, { os: "windows", spawn: windows.spawn });
  assertEquals(windows.calls[0].command, "cmd");
  assertEquals(windows.calls[0].options.args, ["/c", "start", URL]);
});

Deno.test("openBrowser: throws UserError when the launcher exits with an error", async () => {
  const launcher = fakeLauncher(exited(3));

  const err = await assertRejects(
    () => openBrowser(URL, { os: "linux", spawn: launcher.spawn }),
    UserError,
  );
  assertStringIncludes(err.message, URL);
});

Deno.test("openBrowser: throws UserError when the launcher cannot be started", async () => {
  const launcher = fakeLauncher(() => {
    throw new Deno.errors.NotFound("xdg-open not found");
  });

  const err = await assertRejects(
    () => openBrowser(URL, { os: "linux", spawn: launcher.spawn }),
    UserError,
  );
  assertStringIncludes(err.message, URL);
});

Deno.test("openBrowser: throws UserError when the launcher status rejects", async () => {
  const launcher = fakeLauncher(Promise.reject(new Error("wait failed")));

  await assertRejects(
    () => openBrowser(URL, { os: "linux", spawn: launcher.spawn }),
    UserError,
  );
});

Deno.test("openBrowser: resolves and unrefs a launcher still running after the grace window", async () => {
  // A launcher that never exits, like xdg-open running the browser in the
  // foreground.
  const launcher = fakeLauncher(new Promise<Deno.CommandStatus>(() => {}));

  await openBrowser(URL, { os: "linux", graceMs: 1, spawn: launcher.spawn });

  assertEquals(launcher.unrefCalls(), 1);
});
