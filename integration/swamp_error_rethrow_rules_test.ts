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

/**
 * Architecture fitness rule: a CLI command or renderer that rethrows a
 * libswamp stream error must keep it a UserError (swamp-club#2899).
 *
 * A stream's SwampError is a refusal the user can act on. Rethrown as a
 * plain `Error`, the top-level handler logs it as a crash with a stack
 * trace, and `--json` gains a `stack` field and loses the error code.
 * `userErrorFromSwampError` keeps the message and code and renders the
 * one-line `Error:` form.
 */

import { join } from "@std/path";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
} from "./arch_fitness_helpers.ts";

const ROOT = join(import.meta.dirname!, "..");
const SCANNED_DIRS = ["src/cli", "src/presentation"];

/** `new Error(e.error.message)`, whatever the event variable is called. */
const PLAIN_RETHROW_RE = /\bnew Error\(\s*\w+\.error\.message\s*\)/g;

/**
 * Plain-Error rethrows of stream errors, keyed by file with an occurrence
 * suffix, so a new one in an already-pinned file is still reported.
 */
async function plainRethrows(): Promise<string[]> {
  const keys: string[] = [];
  for (const dir of SCANNED_DIRS) {
    for await (const filePath of productionSourceFiles(join(ROOT, dir))) {
      const source = await Deno.readTextFile(filePath);
      const count = [...source.matchAll(PLAIN_RETHROW_RE)].length;
      for (let i = 1; i <= count; i++) {
        keys.push(`${repoRelative(filePath)} #${i}`);
      }
    }
  }
  return keys.sort();
}

const PINNED: readonly string[] = [
  // serve's background worker prune: its error is logged by serve, never
  // rendered to a CLI user.
  "src/cli/commands/serve.ts #1",
  // A resolveOrCreateDefinition result inside the model resolver a workflow
  // step calls: the error fails that step and is never rendered here.
  "src/cli/commands/workflow_resume.ts #1",
  "src/cli/commands/workflow_run.ts #1",
];

Deno.test("swamp error rethrow: CLI and renderers rethrow stream errors as UserError", async () => {
  assertPinnedSet(
    await plainRethrows(),
    PINNED,
    "Stream errors rethrown as a plain Error",
    "Throw userErrorFromSwampError(e.error) from src/libswamp/mod.ts instead, " +
      "so the user sees a one-line error without a stack trace " +
      "(swamp-club#2899).",
  );
});
