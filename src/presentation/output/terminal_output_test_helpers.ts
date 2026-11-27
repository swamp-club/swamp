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
import { hasControlCharacter } from "../../domain/control_characters.ts";

/** console.log output with the renderer's colour codes left in, unlike stripAnsiCode */
export function captureRaw(render: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (message: string) => lines.push(message);
  try {
    render();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

// deno-lint-ignore no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

// ignores newlines and any SGR code, even injected ones: also assert the escaped input is present
export function assertNoControlCharacters(output: string): void {
  const rest = output.replace(SGR, "").replaceAll("\n", "");
  assert(
    !hasControlCharacter(rest),
    `a control character reached the terminal: ${JSON.stringify(rest)}`,
  );
}
