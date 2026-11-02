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
import { relative } from "@std/path";
import {
  productionSourceFiles,
  ROOT,
  SRC_DIR,
  toPosixPath,
} from "./arch_fitness_helpers.ts";

const PINNED_KEY_ENV_READERS = [
  "src/infrastructure/persistence/api_key_source.ts",
];

const KEY_ENV_LITERAL = /(["'])SWAMP_API_KEY(?:_FILE)?\1/;
// Backticks are matched only as an env read: prose in template-literal
// messages and doc comments names the variable without reading it.
const KEY_ENV_TEMPLATE_READ = /\.(?:get|has)\(\s*`SWAMP_API_KEY(?:_FILE)?`/;

Deno.test("api key source: only api_key_source.ts names the key env vars", async () => {
  const readers: string[] = [];
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(path);
    if (KEY_ENV_LITERAL.test(source) || KEY_ENV_TEMPLATE_READ.test(source)) {
      readers.push(toPosixPath(relative(ROOT, path)));
    }
  }

  assertEquals(
    readers.sort(),
    [...PINNED_KEY_ENV_READERS].sort(),
    "a production file names SWAMP_API_KEY or SWAMP_API_KEY_FILE as a string " +
      "literal. Read the collective key with resolveApiKey(), and check for " +
      "one with hasApiKeySource() or apiKeySourceName(), from " +
      "src/infrastructure/persistence/api_key_source.ts, so the " +
      "--club-api-key-file flag and SWAMP_API_KEY_FILE reach every caller.",
  );
});
