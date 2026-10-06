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
 * The characters a terminal interprets instead of printing, as the body of a
 * regular-expression character class: C0 controls (U+0000–U+001F, including
 * tab and newline), DEL (U+007F) and C1 controls (U+0080–U+009F). Step and job
 * name validation and shell-word quoting both build on this one definition so
 * their ranges cannot drift (swamp-club#3027).
 */
export const CONTROL_CHARACTER_CLASS = "\\x00-\\x1f\\x7f-\\x9f";

const CONTROL_CHARACTER = new RegExp(`[${CONTROL_CHARACTER_CLASS}]`);
const EVERY_CONTROL_CHARACTER = new RegExp(`[${CONTROL_CHARACTER_CLASS}]`, "g");

/** Whether `value` holds any control character. */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

/**
 * Replaces each control character in `value` with what `replacement` returns
 * for it. Text without control characters is returned unchanged.
 */
export function mapControlCharacters(
  value: string,
  replacement: (character: string) => string,
): string {
  return value.replace(EVERY_CONTROL_CHARACTER, replacement);
}

/**
 * Rewrites each control character in `value` as a visible `\xNN` escape, so
 * author-controlled text can be printed without driving the terminal. Text
 * without control characters is returned unchanged.
 */
export function escapeControlCharacters(value: string): string {
  return mapControlCharacters(
    value,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}
