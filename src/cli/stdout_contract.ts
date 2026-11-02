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
 * commands whose stdout carries a value (piped, captured, redirected) rather
 * than prose, where a stray log line is corruption; runCli routes their log
 * output to stderr. Nothing detects a new one, so add it by hand
 */

/**
 * first-rule is the same body as invite link, registered hidden at top level;
 * both are listed because both are reachable
 */
export const VALUE_ONLY_STDOUT_COMMANDS: readonly (readonly string[])[] = [
  ["invite", "link"],
  ["first-rule"],
  ["vault", "read-secret"],
  ["worker", "exec-dispatch"],
] as const;

export interface InvokedCommand {
  command: string;
  subcommand?: string;
}

/**
 * the caller's parse has to be right: a misparsed command silently reads as not
 * in the list, and the only symptom is a corrupted pipe
 */
export function isValueOnlyStdoutCommand(info: InvokedCommand): boolean {
  return VALUE_ONLY_STDOUT_COMMANDS.some(([command, subcommand]) =>
    command === info.command && subcommand === info.subcommand
  );
}
