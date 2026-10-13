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
 * The per-surface text of a CLI command: how a user types it. A command
 * built from a factory renders its `--help` examples and any hints that
 * name the command from this value, so the same command can be mounted
 * under more than one spelling (`swamp model …` today, `swamp behavior …`
 * later; swamp-club#3330) without the help text of one surface naming the
 * other.
 */
export interface CommandSyntax {
  /** The words a user types to reach the command, e.g. `swamp model get`. */
  readonly invocation: string;
}

/** The syntax of the subcommand `word` mounted under `parent`. */
export function subcommandSyntax(
  parent: CommandSyntax,
  word: string,
): CommandSyntax {
  return { invocation: `${parent.invocation} ${word}` };
}
