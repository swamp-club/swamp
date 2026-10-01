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

import type { CommandInvocationData } from "../domain/telemetry/command_invocation.ts";

/**
 * When the auth gate runs for an invocation.
 *
 *   - `exempt`: never gated. Bare `swamp` (prints help, runs nothing), the
 *     bare `auth` group, and `auth login`, `auth logout` and `auth whoami`,
 *     which are the path to a credential and the way to diagnose one.
 *   - `deferred`: a help or version flag appears on the line. Cliffy answers
 *     `--help`/`--version` while parsing and exits before any action, so the
 *     gate runs from the global action instead: if Cliffy showed help it
 *     never runs, and if the token was really an option's value it does.
 *     Deciding from the raw token alone would let `--input --help` skip it.
 *   - `startup`: everything else, gated before any startup work.
 */
export type AuthGateTiming = "exempt" | "deferred" | "startup";

const EXEMPT_AUTH_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "login",
  "logout",
  "whoami",
]);

const HELP_OR_VERSION_FLAGS: ReadonlySet<string> = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
]);

export function authGateTiming(
  commandInfo: CommandInvocationData,
  args: readonly string[],
): AuthGateTiming {
  if (commandInfo.command === "") return "exempt";
  if (commandInfo.command === "auth") {
    if (commandInfo.subcommand === undefined) return "exempt";
    if (EXEMPT_AUTH_SUBCOMMANDS.has(commandInfo.subcommand)) return "exempt";
  }
  for (const arg of args) {
    // Everything after `--` is a literal argument, never a flag.
    if (arg === "--") break;
    if (HELP_OR_VERSION_FLAGS.has(arg)) return "deferred";
  }
  return "startup";
}
