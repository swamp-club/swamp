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

// a CLI command that builds its own direct-type resolver can drop an argument
// the run path passes, so the CLI composes createDirectTypeResolver instead

import {
  assertPinnedSet,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const DEFINING_FILE = "src/libswamp/models/direct_execution.ts";

const PINNED_CALLERS: readonly string[] = [
  "src/cli/direct_type_resolver.ts",
  "src/serve/deps.ts",
];

Deno.test("resolveOrCreateDefinition is called only by the shared CLI resolver and serve", async () => {
  const callers: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel === DEFINING_FILE) continue;
    const code = (await Deno.readTextFile(filePath))
      .split("\n")
      .filter((line) => !isCommentLine(line))
      .join("\n");
    if (/\bresolveOrCreateDefinition\s*\(/.test(code)) callers.push(rel);
  }
  assertPinnedSet(
    callers.sort(),
    PINNED_CALLERS,
    "resolveOrCreateDefinition callers",
    "Build a direct-type resolver with createDirectTypeResolver from src/cli/direct_type_resolver.ts rather than calling resolveOrCreateDefinition directly.",
  );
});
