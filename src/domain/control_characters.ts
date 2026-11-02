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
 * one definition of the characters a terminal interprets instead of printing,
 * shared by name validation and shell-word quoting so their ranges cannot drift
 */
export const CONTROL_CHARACTER_CLASS = "\\x00-\\x1f\\x7f-\\x9f";

const CONTROL_CHARACTER = new RegExp(`[${CONTROL_CHARACTER_CLASS}]`);
const EVERY_CONTROL_CHARACTER = new RegExp(`[${CONTROL_CHARACTER_CLASS}]`, "g");

export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

export function mapControlCharacters(
  value: string,
  replacement: (character: string) => string,
): string {
  return value.replace(EVERY_CONTROL_CHARACTER, replacement);
}

/**
 * author-controlled text is escaped as visible \xNN so it can be printed
 * without driving the terminal
 */
export function escapeControlCharacters(value: string): string {
  return mapControlCharacters(value, escapeControlCharacter);
}

export function escapeControlCharactersInMessage(value: string): string {
  return mapControlCharacters(
    value,
    (c) => c === "\n" ? c : escapeControlCharacter(c),
  );
}

function escapeControlCharacter(character: string): string {
  return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
}
