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

import type { AnyCommand } from "./cli_schema.ts";
import { resolveTelemetryInvocation } from "./telemetry_invocation.ts";

/**
 * Whether the auth gate runs for an invocation: `exempt` or `gated`.
 *
 * Exempt are:
 *   - bare `swamp` (prints help) and any line Cliffy will answer with help or
 *     version output instead of running a command;
 *   - the bare `auth` group, `auth login`, `auth logout` and `auth whoami`,
 *     the path to a credential;
 *   - commands that touch no swamp feature: `help` (the structured `--help`
 *     agents read), `completions` (shell rc files run it at every shell
 *     start), `version` (as `--version` is) and `update` (a blocked user, or
 *     a CI host after a signing-key rotation, must be able to install the
 *     release that fixes it).
 * `worker connect` is `enrollment`: gated, except that a worker without a
 * credential may instead pass on the serve that enrolls it
 * (design/surfaces/auth-gate.md, "Remote workers"). Everything else is
 * gated.
 *
 * The decision is made against the real command tree — the same declarations
 * Cliffy parses — never a guess from token positions. A guess once took
 * `swamp --log init` for bare `swamp`, because it did not know `--log` takes
 * no value, and let `init` run unauthenticated.
 */
export type AuthGateTiming = "exempt" | "gated" | "enrollment";

const EXEMPT_AUTH_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "login",
  "logout",
  "whoami",
]);

/** Top-level commands that touch no swamp feature, with their subcommands. */
const UNGATED_COMMANDS: ReadonlySet<string> = new Set([
  "help",
  "completions",
  "version",
  "update",
]);

const HELP_OR_VERSION_FLAGS: ReadonlySet<string> = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
]);

export function authGateTiming(
  tree: AnyCommand,
  args: readonly string[],
): AuthGateTiming {
  const resolved = resolveTelemetryInvocation(tree, [...args], []);
  const path = resolved.commandPath ?? [];
  // `args` holds the command words after the subcommand plus positionals, so
  // with a path of zero or one word it holds positionals only.
  const noPositionals = resolved.args.length === 0;

  if (path.length === 0 && noPositionals) return "exempt";
  if (path.length > 0 && UNGATED_COMMANDS.has(path[0])) return "exempt";
  if (path[0] === "auth") {
    if (path.length === 1 && noPositionals) return "exempt";
    if (path.length >= 2 && EXEMPT_AUTH_SUBCOMMANDS.has(path[1])) {
      return "exempt";
    }
  }
  if (answersWithHelpOrVersion(tree, path, args)) return "exempt";
  if (path.length === 2 && path[0] === "worker" && path[1] === "connect") {
    return "enrollment";
  }
  return "gated";
}

/** The commands from the root to the resolved leaf. */
function commandChain(tree: AnyCommand, path: readonly string[]): AnyCommand[] {
  const chain = [tree];
  let current: AnyCommand | undefined = tree;
  for (const name of path) {
    current = current?.getCommand(name, true);
    if (!current) break;
    chain.push(current);
  }
  return chain;
}

function declares(chain: readonly AnyCommand[], key: string): boolean {
  const name = key.replace(/^--?/, "");
  return chain.some((command) =>
    command.getOption(name, true) !== undefined ||
    (name.startsWith("no-") &&
      command.getOption(name.slice(3), true) !== undefined)
  );
}

function takesValue(chain: readonly AnyCommand[], key: string): boolean {
  const name = key.replace(/^--?/, "");
  return chain.some((command) => {
    const option = command.getOption(name, true) ??
      (name.startsWith("no-")
        ? command.getOption(name.slice(3), true)
        : undefined);
    return (option?.args ?? []).length > 0;
  });
}

/**
 * True when a help or version flag on the line is one Cliffy will act on.
 * It errs toward gating: a token that follows any option taking a value
 * (required or optional) may be that value, and a name some command on the
 * path declares as its own option is that option, not help.
 */
function answersWithHelpOrVersion(
  tree: AnyCommand,
  path: readonly string[],
  args: readonly string[],
): boolean {
  const chain = commandChain(tree, path);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Everything after `--` is a literal argument, never a flag.
    if (arg === "--") return false;
    if (!HELP_OR_VERSION_FLAGS.has(arg)) continue;
    if (declares(chain, arg)) continue;
    const previous = args[i - 1];
    if (
      previous !== undefined && previous.startsWith("-") &&
      !previous.includes("=") && takesValue(chain, previous)
    ) {
      continue;
    }
    return true;
  }
  return false;
}
