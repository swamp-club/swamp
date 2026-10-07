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

// createModelDeleteDeps falls back to a definition repository that only
// looks in .swamp/auto-definitions. With a datastore configured,
// auto-definitions live in the datastore, so a caller that omits the
// injected definition repo cannot find or delete them (swamp-club#2382).

import { assertGreater } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join } from "@std/path";
import {
  assertPinnedSet,
  isCommentLine,
  repoRelative,
  SRC_DIR,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

/** Callers that still omit the injected definition repo. */
const PINNED_WITHOUT_DEFINITION_REPO = [
  // Worker prune: swamp-club#3155.
  "src/cli/commands/serve.ts: serveCommand",
  "src/cli/commands/worker_prune.ts: workerPruneCommand",
  "src/serve/handlers/admin_handlers.ts: handleWorkerPrune",
];

/** Position of the injectedDefinitionRepo parameter. */
const DEFINITION_REPO_ARG = 5;

/** Top-level argument count of each `createModelDeleteDeps(...)` call. */
function callArgCounts(code: string): { line: number; count: number }[] {
  const source = code
    .split("\n")
    .map((line) => isCommentLine(line) ? "" : line)
    .join("\n");
  const calls: { line: number; count: number }[] = [];
  for (const match of source.matchAll(/\bcreateModelDeleteDeps\s*\(/g)) {
    let depth = 0;
    let count = 0;
    let current = "";
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const ch = source[i];
      if (depth === 0 && ch === ")") break;
      if (depth === 0 && ch === ",") {
        if (current.trim() !== "") count++;
        current = "";
        continue;
      }
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      current += ch;
    }
    if (current.trim() !== "") count++;
    calls.push({
      line: source.slice(0, match.index).split("\n").length - 1,
      count,
    });
  }
  return calls;
}

Deno.test("createModelDeleteDeps callers in cli and serve pass the injected definition repo", async () => {
  const missing: string[] = [];
  let scanned = 0;
  for (const dir of ["cli", "serve"]) {
    for await (
      const entry of walk(join(SRC_DIR, dir), {
        exts: [".ts"],
        skip: [/_test\.ts$/],
      })
    ) {
      const code = await Deno.readTextFile(entry.path);
      const owners = topLevelOwners(code.split("\n"));
      for (const call of callArgCounts(code)) {
        scanned++;
        if (call.count < DEFINITION_REPO_ARG) {
          missing.push(`${repoRelative(entry.path)}: ${owners[call.line]}`);
        }
      }
    }
  }

  // model delete, serve model delete, server token gc and the three
  // worker-prune callers: a scan that matches nothing must not pass.
  assertGreater(scanned, 5);
  assertPinnedSet(
    missing.sort(),
    PINNED_WITHOUT_DEFINITION_REPO,
    "createModelDeleteDeps without an injected definition repo",
    "Pass repoContext.definitionRepo as injectedDefinitionRepo so " +
      "auto-definitions are found where the datastore keeps them.",
  );
});
