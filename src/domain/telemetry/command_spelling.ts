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
 * telemetry records all three spellings in the swamp model form so a command
 * counts the same however typed; this field keeps the typed word and is
 * undefined for other groups and self-recorded entries
 */
export type CommandSpelling = "model" | "behavior" | "behaviour";

export const COMMAND_SPELLINGS: readonly CommandSpelling[] = [
  "model",
  "behavior",
  "behaviour",
];

/**
 * a spool file on disk can be hand-edited or written by a newer version, so
 * decoded values are not trusted to be known variants
 */
export function isCommandSpelling(value: unknown): value is CommandSpelling {
  return typeof value === "string" &&
    (COMMAND_SPELLINGS as readonly string[]).includes(value);
}
