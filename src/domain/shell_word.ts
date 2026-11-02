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

import {
  hasControlCharacter,
  mapControlCharacters,
} from "./control_characters.ts";

const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * a value with a control character uses ANSI-C form so the hint is visibly
 * escaped, cannot drive the terminal, and still pastes correctly in bash and
 * zsh
 */
export function quoteShellWord(value: string): string {
  if (SHELL_SAFE_WORD.test(value)) return value;
  if (hasControlCharacter(value)) return ansiCQuote(value);
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * C0 and DEL are one UTF-8 byte so \xNN round-trips; C1 is two bytes so it is
 * written as \uNNNN (bash 4.2+ and zsh)
 */
function ansiCQuote(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  const body = mapControlCharacters(escaped, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x80
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
  return `$'${body}'`;
}
