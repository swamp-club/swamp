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

import { assert, assertEquals } from "@std/assert";
import {
  type CommandLookupRunner,
  defaultCommandResolver,
} from "./resolve_command.ts";

Deno.test("defaultCommandResolver: resolves a binary that exists (deno)", async () => {
  // `deno` is on PATH on every CI runner — POSIX or Windows.
  const resolver = defaultCommandResolver();
  const path = await resolver.resolve("deno");
  assert(path !== null, "expected deno to resolve to a path");
  assert(path.length > 0, "expected non-empty path");
  // Whatever the platform, the resolved path should contain "deno".
  assert(
    path.toLowerCase().includes("deno"),
    `expected resolved path to contain "deno"; got ${path}`,
  );
});

Deno.test("defaultCommandResolver: returns null for a binary that does not exist", async () => {
  const resolver = defaultCommandResolver();
  const path = await resolver.resolve("some-nonsense-binary-xyz");
  assertEquals(path, null);
});

Deno.test("defaultCommandResolver: returns first non-empty line of multi-line output", async () => {
  // Stream-0 deferred check: when `which`/`where` reports multiple matches
  // (one per line), only the first line is returned.
  const fakeRunner: CommandLookupRunner = (_tool, _name) =>
    Promise.resolve({
      success: true,
      stdout: new TextEncoder().encode(
        "/usr/local/bin/foo\n/opt/homebrew/bin/foo\n/usr/bin/foo\n",
      ),
    });

  const resolver = defaultCommandResolver(fakeRunner);
  const path = await resolver.resolve("foo");
  assertEquals(path, "/usr/local/bin/foo");
});

Deno.test("defaultCommandResolver: skips leading blank lines", async () => {
  const fakeRunner: CommandLookupRunner = (_tool, _name) =>
    Promise.resolve({
      success: true,
      stdout: new TextEncoder().encode(
        "\n   \n/usr/bin/foo\n/usr/local/bin/foo\n",
      ),
    });

  const resolver = defaultCommandResolver(fakeRunner);
  const path = await resolver.resolve("foo");
  assertEquals(path, "/usr/bin/foo");
});

Deno.test("defaultCommandResolver: returns null when lookup process fails", async () => {
  const fakeRunner: CommandLookupRunner = (_tool, _name) =>
    Promise.resolve({
      success: false,
      stdout: new TextEncoder().encode("/usr/bin/foo\n"),
    });

  const resolver = defaultCommandResolver(fakeRunner);
  const path = await resolver.resolve("foo");
  assertEquals(path, null);
});

Deno.test("defaultCommandResolver: returns null when stdout is empty", async () => {
  const fakeRunner: CommandLookupRunner = (_tool, _name) =>
    Promise.resolve({
      success: true,
      stdout: new Uint8Array(),
    });

  const resolver = defaultCommandResolver(fakeRunner);
  const path = await resolver.resolve("foo");
  assertEquals(path, null);
});

Deno.test("defaultCommandResolver: uses the platform-appropriate lookup tool", async () => {
  let seenTool = "";
  const fakeRunner: CommandLookupRunner = (tool, _name) => {
    seenTool = tool;
    return Promise.resolve({
      success: true,
      stdout: new TextEncoder().encode("/usr/bin/foo\n"),
    });
  };

  const resolver = defaultCommandResolver(fakeRunner);
  await resolver.resolve("foo");
  assertEquals(seenTool, Deno.build.os === "windows" ? "where" : "which");
});

Deno.test("defaultCommandResolver: trims trailing CR on Windows-style line endings", async () => {
  // `where` on Windows emits CRLF line terminators.
  const fakeRunner: CommandLookupRunner = (_tool, _name) =>
    Promise.resolve({
      success: true,
      stdout: new TextEncoder().encode(
        "C:\\Tools\\foo.exe\r\nC:\\Other\\foo.exe\r\n",
      ),
    });

  const resolver = defaultCommandResolver(fakeRunner);
  const path = await resolver.resolve("foo");
  assertEquals(path, "C:\\Tools\\foo.exe");
});
