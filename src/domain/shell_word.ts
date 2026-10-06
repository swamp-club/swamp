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

/** A POSIX shell word made only of these characters needs no quoting. */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quotes a value for a command printed for the user to paste into a POSIX
 * shell. A value made only of safe characters is returned as-is; anything
 * else is single-quoted, each embedded single quote written as `'"'"'`.
 *
 * A value holding a control character is written in ANSI-C form instead
 * (`$'…'` with each control character as a `\xNN` escape), so the hint is
 * visibly escaped and cannot drive the terminal, and still pastes correctly
 * in bash and zsh (swamp-club#3027). Step and job names refuse control
 * characters at validation, so this form only appears for a name that
 * reached the client from an older server or from a forEach item value.
 */
export function quoteShellWord(value: string): string {
  if (SHELL_SAFE_WORD.test(value)) return value;
  if (hasControlCharacter(value)) return ansiCQuote(value);
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * ANSI-C quoting. A C0 or DEL character is one byte in UTF-8, so `\xNN`
 * pastes back to the same character; a C1 character is two bytes, so it is
 * written as `\uNNNN` (bash 4.2+ and zsh) to survive the round trip.
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
