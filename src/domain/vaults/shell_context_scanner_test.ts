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
import {
  classifyShellPositions,
  type ShellContext,
} from "./shell_context_scanner.ts";

/** Classifies the position of every `X` marker in the command. */
function contexts(command: string): ShellContext[] {
  const positions: number[] = [];
  for (
    let i = command.indexOf("X");
    i !== -1;
    i = command.indexOf("X", i + 1)
  ) {
    positions.push(i);
  }
  return classifyShellPositions(command, positions);
}

const cases: [string, string, ShellContext[]][] = [
  ["unquoted word", "echo X", ["unquoted"]],
  ["double quotes", 'echo "a X b"', ["double"]],
  ["single quotes", "echo 'a X b'", ["single"]],
  ["ANSI-C quotes", "echo $'a\\'X'", ["ansi-c"]],
  ["escaped quote outside quotes", "echo \\'X", ["unquoted"]],
  ["comment with an apostrophe", "echo X # don't\necho X", [
    "unquoted",
    "unquoted",
  ]],
  ["command substitution restarts quoting", `echo "$(echo 'X') X"`, [
    "single",
    "double",
  ]],
  ["backticks restart quoting", "echo \"`echo 'X'` X\"", ["single", "double"]],
  ["arithmetic shift is not a heredoc", "echo $((1<<2)) X", ["unquoted"]],
  ["here-string", "cat <<< X", ["unquoted"]],
  ["unquoted heredoc body", "cat <<EOF\nX\nEOF\necho X", [
    "heredoc",
    "unquoted",
  ]],
  ["quoted heredoc body", "cat <<'EOF'\nX\nEOF", ["heredoc-literal"]],
  ["partly quoted delimiter", 'cat <<E"O"F\nX\nEOF', ["heredoc-literal"]],
  ["backslash delimiter", "cat <<\\EOF\nX\nEOF", ["heredoc-literal"]],
  ["dash heredoc strips tabs", "cat <<-EOF\n\tX\n\tEOF\necho 'X'", [
    "heredoc",
    "single",
  ]],
  ["two heredocs on one line", "cat <<A <<'B'\nX\nA\nX\nB", [
    "heredoc",
    "heredoc-literal",
  ]],
  ["missing terminator runs to the end", "cat <<EOF\nX", ["heredoc"]],
  ["heredoc operator inside quotes", "echo '<<EOF'\nX", ["unquoted"]],
  ["shift inside an arithmetic command", "(( n <<= 1 ))\necho 'X' X", [
    "single",
    "unquoted",
  ]],
];

for (const [name, command, expected] of cases) {
  Deno.test(`classifyShellPositions: ${name}`, () => {
    assertEquals(contexts(command), expected);
  });
}
