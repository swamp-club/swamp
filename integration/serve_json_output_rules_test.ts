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
import { join } from "@std/path";
import {
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const SERVE_COMMAND = join(SRC_DIR, "cli", "commands", "serve.ts");
const SERVE_DIR = join(SRC_DIR, "serve");

// a method running in serve's process swaps the global console, so a line
// written through it lands on stderr; serve writes --json lines unguarded
const CONSOLE_CALL =
  /\bconsole\.(?:log|error|warn|info|debug|dir|table|trace)\s*\(/;

async function consoleCalls(file: string): Promise<string[]> {
  const lines = (await Deno.readTextFile(file)).split("\n");
  const sites: string[] = [];
  lines.forEach((line, i) => {
    if (!isCommentLine(line) && CONSOLE_CALL.test(line)) {
      sites.push(`${repoRelative(file)}:${i + 1}: ${line.trim()}`);
    }
  });
  return sites;
}

Deno.test("serve json output: serve.ts writes nothing through the global console", async () => {
  assertEquals(await consoleCalls(SERVE_COMMAND), []);
});

Deno.test("serve json output: src/serve writes nothing through the global console", async () => {
  const sites: string[] = [];
  for await (const file of productionSourceFiles(SERVE_DIR)) {
    sites.push(...await consoleCalls(file));
  }
  assertEquals(sites, []);
});
