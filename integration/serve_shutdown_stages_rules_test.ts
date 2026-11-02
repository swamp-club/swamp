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

import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  assertPinnedSet,
  isCommentLine,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const SERVE_COMMAND = join(SRC_DIR, "cli", "commands", "serve.ts");

/** awaits after the drain that are not a stage, each reviewed */
const PINNED_UNSTAGED_AWAITS: readonly string[] = [
  // the pid file, removed after ac.abort() released the server
  "await Deno.remove(pidPath)",
];

/** index just past the `)` closing the call whose `(` ends at `open` */
function callEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < source.length && source[i] !== ch; i++) {
        if (source[i] === "\\") i++;
      }
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) return i + 1;
      depth--;
    }
  }
  return source.length;
}

Deno.test("serve shutdown: every await after the drain is a bounded ShutdownStages stage", async () => {
  const code = (await Deno.readTextFile(SERVE_COMMAND))
    .split("\n")
    .map((line) => isCommentLine(line) ? "" : line)
    .join("\n");
  const start = code.indexOf("const shutdown = async () => {");
  assert(start >= 0, "the shutdown closure was not found in serve.ts");
  const end = code.indexOf("\n    };\n", start);
  assert(end > start, "the end of the shutdown closure was not found");
  const body = code.slice(start, end);
  assert(
    body.includes("new ShutdownStages("),
    "the shutdown closure builds no ShutdownStages",
  );
  const drain = body.indexOf("runShutdownDrain(");
  assert(drain >= 0, "the shutdown closure runs no drain");
  const afterDrain = callEnd(body, drain + "runShutdownDrain(".length);

  const staged: [number, number][] = [];
  for (const match of body.matchAll(/\bstages\.run\(/g)) {
    staged.push([match.index, callEnd(body, match.index + match[0].length)]);
  }
  assert(staged.length > 0, "the shutdown closure runs no stage");

  const unstaged: string[] = [];
  for (const match of body.matchAll(/\bawait\s+([^;\n]*)/g)) {
    if (match.index < afterDrain) continue;
    if (match[1].startsWith("stages.run(")) continue;
    if (staged.some(([from, to]) => match.index > from && match.index < to)) {
      continue;
    }
    unstaged.push(`await ${match[1].trim()}`);
  }
  assertPinnedSet(
    unstaged,
    PINNED_UNSTAGED_AWAITS,
    "Unbounded awaits in the serve shutdown closure",
    "Run the stage through stages.run(...) so it takes its bound from the shutdown deadline and is named in the log when it stalls.",
  );
});
