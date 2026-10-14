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
 * The root word typed for an invocation of the behavior group
 * (swamp-club#3411).
 *
 * "Behavior" is the product term for a model: `swamp behavior …` and its
 * British alias `swamp behaviour …` reach the same commands as
 * `swamp model …`. Telemetry records all three in the `swamp model` form,
 * so the same command counts the same however it was typed, and this field
 * keeps the word that was typed. Invocations of every other group, and the
 * entries swamp records on its own (workflow steps, serve runs), leave it
 * `undefined`.
 */
export type CommandSpelling = "model" | "behavior" | "behaviour";

/** Every valid command spelling, for validation and exhaustive iteration. */
export const COMMAND_SPELLINGS: readonly CommandSpelling[] = [
  "model",
  "behavior",
  "behaviour",
];

/**
 * Narrows an arbitrary value to a CommandSpelling.
 *
 * Used when decoding persisted entries: a spool file is on disk and can be
 * hand-edited or written by a newer version, so the value is not trusted to
 * be one of the known variants.
 */
export function isCommandSpelling(value: unknown): value is CommandSpelling {
  return typeof value === "string" &&
    (COMMAND_SPELLINGS as readonly string[]).includes(value);
}
