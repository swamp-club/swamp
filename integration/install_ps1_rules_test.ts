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

// Architectural fitness test: scripts/install.ps1 is safe to run with
// `irm https://swamp-club.com/install.ps1 | iex`, the documented Windows
// install. Under iex the script runs inside the caller's own PowerShell
// session, so `exit` closes the user's window and anything set at the top
// level (the error preference, functions, variables) leaks into their session.
// The script keeps only its param block at the top level and runs everything
// else in a child scope (`& { ... }`), and never calls `exit`.
//
// The checks read the script as text: there is no PowerShell on the Linux and
// macOS CI runners. The count assertions keep them from passing vacuously if
// the comment stripping or the depth tracking stops matching.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ROOT } from "./arch_fitness_helpers.ts";

const INSTALL_PS1 = join(ROOT, "scripts", "install.ps1");

interface CodeLine {
  lineNumber: number;
  text: string;
  /** Combined brace and parenthesis nesting depth at the start of the line. */
  depth: number;
}

/**
 * The script's code lines with comments removed: the `<# ... #>` help block
 * and every line whose first non-blank character is `#`.
 */
function codeLines(source: string): CodeLine[] {
  const lines = source.split(/\r?\n/);
  const result: CodeLine[] = [];
  let inBlockComment = false;
  let depth = 0;
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (inBlockComment) {
      if (trimmed.includes("#>")) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith("<#")) {
      inBlockComment = !trimmed.includes("#>");
      return;
    }
    if (trimmed === "" || trimmed.startsWith("#")) return;
    result.push({ lineNumber: index + 1, text: trimmed, depth });
    for (const char of trimmed) {
      if (char === "{" || char === "(") depth++;
      if (char === "}" || char === ")") depth--;
    }
  });
  assertEquals(depth, 0, "install.ps1 braces and parentheses do not balance");
  return result;
}

Deno.test("install.ps1: never calls exit", async () => {
  const lines = codeLines(await Deno.readTextFile(INSTALL_PS1));
  assert(lines.length > 100, `only ${lines.length} code lines found`);

  const exits = lines.filter((line) => /\bexit\b/i.test(line.text));
  assertEquals(
    exits.map((line) => `${line.lineNumber}: ${line.text}`),
    [],
    "exit in a script run with irm | iex closes the user's PowerShell " +
      "window; throw instead",
  );
});

Deno.test("install.ps1: only the param block and the child-scope invocation are top-level statements", async () => {
  const lines = codeLines(await Deno.readTextFile(INSTALL_PS1));

  const topLevel = lines.filter((line) => line.depth === 0);
  assertEquals(
    topLevel.map((line) => line.text),
    ["[CmdletBinding()]", "param(", "& {"],
    "everything except the param block must run inside `& { ... }` so it " +
      "does not leak into the session of a user who runs the script with " +
      "irm | iex",
  );

  const errorPreference = lines.filter((line) =>
    /^\$ErrorActionPreference\s*=/i.test(line.text)
  );
  assertEquals(errorPreference.length, 1);
  assertEquals(errorPreference[0].depth, 1);
});
