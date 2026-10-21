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

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  DENO_CONFIG_FILE_NAMES,
  parseDenoConfig,
  readDenoConfig,
} from "./deno_config.ts";

Deno.test("DENO_CONFIG_FILE_NAMES: deno.json comes before deno.jsonc, as Deno picks", () => {
  assertEquals([...DENO_CONFIG_FILE_NAMES], ["deno.json", "deno.jsonc"]);
});

Deno.test("parseDenoConfig: reads comments and trailing commas", () => {
  assertEquals(
    parseDenoConfig(
      '// project config\n{ "imports": { "ms": "npm:ms@2.1.2", }, /* x */ }',
    ),
    { imports: { ms: "npm:ms@2.1.2" } },
  );
});

Deno.test("parseDenoConfig: a config that is not an object is undefined", () => {
  assertEquals(parseDenoConfig("[1, 2]"), undefined);
  assertEquals(parseDenoConfig("null"), undefined);
  assertEquals(parseDenoConfig('"deno"'), undefined);
});

Deno.test("parseDenoConfig: throws on text that is not JSONC", () => {
  assertThrows(() => parseDenoConfig('{ "imports": '));
});

Deno.test("readDenoConfig: undefined for a missing or unparseable file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readDenoConfig(join(dir, "missing.json")), undefined);
    const broken = join(dir, "deno.jsonc");
    await Deno.writeTextFile(broken, "{ nope");
    assertEquals(await readDenoConfig(broken), undefined);
    await Deno.writeTextFile(broken, '{ "lock": false } // trailing');
    assertEquals(await readDenoConfig(broken), { lock: false });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
