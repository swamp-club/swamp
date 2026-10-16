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
import { findOption, optionConsumesNext } from "./telemetry_invocation.ts";

/**
 * The option given an empty value — with `=` (`--title=`, `-t=`, `-qt=`) or
 * as an empty next token (`--title ""`) — as the flag Cliffy names in its own
 * errors (`--title`), or `undefined` when every option value is present.
 *
 * Cliffy 1.0.1 reads an empty value after `=` as no value at all and takes
 * the next token instead, so `--title= --no-redact --body x` parses as a title
 * of `--no-redact` and silently drops the flag (swamp-club#3542). Checking
 * argv against the command tree before Cliffy parses it reports every empty
 * value the same way, wherever it appears and however it is spelled.
 *
 * Walks argv the way telemetry_invocation.ts does: subcommand words move the
 * walk down the tree, so an option is looked up on the command it is given
 * to, a token taken as an option's value is skipped, and nothing after `--`
 * is read. Only options that take a value are reported — a boolean flag
 * (`--force=`) and a negated one (`--no-color=`) never read the next token,
 * and an unknown option is left for Cliffy to reject.
 */
export function findEmptyOptionValue(
  root: AnyCommand,
  args: string[],
): string | undefined {
  let current: AnyCommand = root;
  // Once a positional is seen, later words are arguments, not subcommands.
  let atLeaf = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return undefined;

    if (arg.startsWith("-") && arg.length > 1) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        if (args[i + 1] === "") {
          const flag = emptyValueFlag(current, arg);
          if (flag !== undefined) return flag;
        }
        if (optionConsumesNext(current, arg, args[i + 1])) i++;
      } else if (eq === arg.length - 1) {
        const flag = emptyValueFlag(current, arg.slice(0, eq));
        if (flag !== undefined) return flag;
      }
      continue;
    }

    if (!atLeaf) {
      const child = current.getCommand(arg, true);
      if (child) {
        current = child;
        continue;
      }
      atLeaf = true;
    }
  }
  return undefined;
}

/** The flag to report for `key` given an empty value, if any. */
function emptyValueFlag(command: AnyCommand, key: string): string | undefined {
  if (key.startsWith("--")) {
    // Cliffy sets a `--no-` option to false without reading a value.
    if (key.startsWith("--no-")) return undefined;
    return valueOptionFlag(command, key);
  }

  // Cliffy splits a short group with `=` into single flags and gives the
  // value to the last one: `-qt=` is `-q -t=`. An earlier letter that takes
  // a value would take the next letter instead, so such a group is left to
  // Cliffy.
  const letters = key.slice(1);
  if (!/^[a-zA-Z]+$/.test(letters)) return undefined;
  const earlierAreFlags = [...letters.slice(0, -1)].every((letter) => {
    const option = command.getOption(letter, true);
    return option !== undefined && (option.args ?? []).length === 0;
  });
  if (!earlierAreFlags) return undefined;
  return valueOptionFlag(command, `-${letters.at(-1)}`);
}

function valueOptionFlag(command: AnyCommand, key: string): string | undefined {
  const option = findOption(command, key);
  if (option === undefined || (option.args ?? []).length === 0) {
    return undefined;
  }
  return option.name.length > 1 ? `--${option.name}` : `-${option.name}`;
}
