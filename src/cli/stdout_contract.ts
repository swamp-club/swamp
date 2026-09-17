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
 * Which commands treat stdout as a value rather than as prose.
 *
 * Most swamp commands write human-readable output to stdout, and a stray log
 * line is at worst untidy. A few write a *value* there — something a caller
 * pipes, captures or redirects — and for those a log line is corruption:
 * `swamp invite link | pbcopy` copies a debug record instead of a URL, and
 * `swamp vault read-secret v k > key.pem` writes one into a key file.
 *
 * The contract existed before it had a name. It was asserted three times, in
 * three places, and never once as a shared term: a comment in the invite-link
 * renderer, a non-TTY branch in the vault-read-secret renderer, and
 * swamp-club#1768, which removed even the trailing newline from a secret. Each
 * assertion held only for the command that made it, which is how
 * swamp-club#2254 shipped — `-v` put a libswamp debug record on stdout ahead of
 * the invite URL, and nothing anywhere knew that was different from any other
 * command's stdout.
 *
 * Naming it here does two things: `runCli` can route log output to stderr for
 * these commands, and the list is enumerable, which is what the fitness test
 * pins and what swamp-club#2259 (stderr by default) starts from.
 *
 * This list is not self-maintaining. Nothing statically detects a new command
 * putting a value on stdout, so a new one must be added here by hand. That
 * limitation is the reason #2259 exists — the honest fix is to invert the
 * default so the list becomes unnecessary.
 */

/**
 * Command paths whose stdout carries a value. Each entry is the invocation as
 * typed, split into segments: `["invite", "link"]` for `swamp invite link`.
 *
 * `first-rule` is the same command body as `invite link`, registered hidden at
 * the top level (see `buildInviteLinkCommand` in `commands/invite_link.ts`).
 * Both are listed because both are reachable, and a reader who finds only one
 * would reasonably assume the other was considered and excluded.
 */
export const VALUE_ONLY_STDOUT_COMMANDS: readonly (readonly string[])[] = [
  ["invite", "link"],
  ["first-rule"],
  ["vault", "read-secret"],
] as const;

/**
 * The shape this predicate needs from a parsed invocation — structural, so this
 * module does not depend on the telemetry parser that happens to produce it.
 */
export interface InvokedCommand {
  command: string;
  subcommand?: string;
}

/**
 * Whether the invoked command writes a value to stdout, and so needs log output
 * routed to stderr.
 *
 * Note the caller's parse has to be right for this to mean anything: a
 * misparsed command silently reads as "not in the list", and the only symptom
 * is a corrupted pipe. See `consumesNextArg` in `telemetry_integration.ts`,
 * which had exactly that bug for `--log-level=debug invite link`.
 */
export function isValueOnlyStdoutCommand(info: InvokedCommand): boolean {
  return VALUE_ONLY_STDOUT_COMMANDS.some(([command, subcommand]) =>
    command === info.command && subcommand === info.subcommand
  );
}
