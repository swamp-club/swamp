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
import { join } from "@std/path";
import { bunCommands, missingBunMessage, usesMise } from "./app_toolchain.ts";

async function withFolder(
  files: readonly string[],
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    for (const file of files) await Deno.writeTextFile(join(dir, file), "");
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

Deno.test("usesMise: a mise config or .tool-versions turns it on", async () => {
  for (const file of ["mise.toml", ".mise.toml", ".tool-versions"]) {
    await withFolder([file], async (dir) => {
      assertEquals(await usesMise(dir), true);
    });
  }
});

Deno.test("usesMise: a folder without one runs Bun from PATH", async () => {
  await withFolder(["package.json"], async (dir) => {
    assertEquals(await usesMise(dir), false);
  });
});

Deno.test("bunCommands: tries mise first, then Bun on PATH", () => {
  assertEquals(bunCommands(true, "vite.js", ["build"]), [
    { command: "mise", args: ["exec", "--", "bun", "vite.js", "build"] },
    { command: "bun", args: ["vite.js", "build"] },
  ]);
  assertEquals(bunCommands(false, "vite.js", []), [
    { command: "bun", args: ["vite.js"] },
  ]);
});

Deno.test("missingBunMessage: names swamp app, not one subcommand", () => {
  assertStringIncludes(
    missingBunMessage(false),
    "swamp app needs Bun on your PATH.",
  );
  assertStringIncludes(missingBunMessage(true), "or mise to install");
});

Deno.test("missingBunMessage: says how to get Bun", () => {
  for (const mise of [false, true]) {
    assertStringIncludes(
      missingBunMessage(mise),
      "Install Bun, or run mise install in the app folder",
    );
  }
});
