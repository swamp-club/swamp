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

import type { CommandInvocationData } from "../domain/telemetry/mod.ts";
import type { AnyCommand } from "./cli_schema.ts";
import { GLOBAL_OPTIONS } from "./telemetry_integration.ts";

/** Placeholder recorded in place of a redacted positional. */
export const REDACTED = "<REDACTED>";

/**
 * Declared argument names whose values are sent as typed.
 *
 * Telemetry policy (swamp-club#2817): names, ids, queries and types are not
 * sensitive — they are how a user refers to things, not the things
 * themselves. Filesystem paths and input values are sensitive, and so is
 * everything after `data query`, whose predicate can embed literal values.
 *
 * Only names listed here are sent. Any argument name not listed — including
 * one added later — is redacted, and
 * `integration/telemetry_redaction_rules_test.ts` fails until it is classified
 * here or in {@link REDACTED_ARGUMENTS}.
 */
export const SENT_ARGUMENTS: ReadonlySet<string> = new Set([
  // Command words taken by `help` and the hidden shell-completion command.
  "action",
  "command",
  "collective",
  "data_name",
  "definition_name",
  "enabled",
  "extension",
  "grant_id",
  "method_name",
  "model_id_or_name",
  "model_or_type",
  "name",
  "new_name",
  "number",
  "old_name",
  "output_id",
  "output_id_or_model_name",
  "query",
  "report_name",
  "run_id_or_workflow",
  "slug",
  "step_name",
  "token-id",
  "type",
  "vault_name",
  "vault_name_or_id",
  "version",
  "workflow_id_or_name",
  "workflow_name",
]);

/**
 * Declared argument names whose values are always redacted: paths, URLs,
 * input values, the `data query` predicate, access groups and principals, and
 * free-form pass-through arguments.
 */
export const REDACTED_ARGUMENTS: ReadonlySet<string> = new Set([
  "args",
  "extra",
  // Access groups and their members: a principal can be an email address.
  "group",
  "manifest-path",
  "path",
  "predicate",
  "principal",
  "unexpected",
  "url",
  "value",
]);

/**
 * `key` is a config setting name under `swamp config` — system-defined — but a
 * secret's name under `swamp vault`, which is an input value.
 */
function isSentArgument(argName: string, commandPath: string[]): boolean {
  if (argName === "key") return commandPath[0] === "config";
  return SENT_ARGUMENTS.has(argName);
}

/**
 * Resolves the telemetry invocation for `args` by walking the real command
 * tree rooted at `root`, rather than guessing from token positions.
 *
 * - Command words are recorded at any depth. `commandPath` holds their
 *   canonical names (aliases resolved). `command`, `subcommand` and the
 *   command words in `args` keep the spelling as typed, because swamp-club
 *   scores XP and quests on `command`/`subcommand` and an alias can score
 *   differently from its canonical name. `subcommand` is only ever a command
 *   word.
 * - Positionals are matched to the leaf command's declared arguments and sent
 *   or redacted by argument name (see {@link SENT_ARGUMENTS}).
 * - Option values are never recorded; only option keys are.
 *
 * Anything that cannot be matched — an unknown option's value, an unknown
 * command, a positional beyond the declared arguments — is redacted, because
 * this also records invocations that failed to parse.
 *
 * `command`, `subcommand` and `args` keep the shape swamp-club already
 * consumes: `args` is the command words after the subcommand followed by the
 * positionals, so `model method run m x` is still `args: ["run", "m", "x"]`.
 */
export function resolveTelemetryInvocation(
  root: AnyCommand,
  args: string[],
): CommandInvocationData {
  const commandPath: string[] = [];
  const typedPath: string[] = [];
  const positionals: string[] = [];
  const optionKeys: string[] = [];
  const globalOptions: string[] = [];

  let current: AnyCommand = root;
  // Once a positional is seen, later words are arguments, not subcommands.
  let atLeaf = false;
  let unknownCommand = false;

  const recordOption = (key: string): void => {
    const bucket = GLOBAL_OPTIONS.has(key) ? globalOptions : optionKeys;
    if (!bucket.includes(key)) bucket.push(key);
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--") {
      // Everything after `--` is literal pass-through.
      for (let j = i + 1; j < args.length; j++) positionals.push(REDACTED);
      break;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg : arg.slice(0, eq);
      recordOption(key);
      if (eq === -1 && optionConsumesNext(current, key, args[i + 1])) {
        i++; // The value is never recorded.
      }
      i++;
      continue;
    }

    if (!atLeaf && !unknownCommand) {
      const child = current.getCommand(arg, true);
      if (child) {
        current = child;
        commandPath.push(child.getName());
        typedPath.push(arg);
        i++;
        continue;
      }
      if (current.getCommands(true).length > 0 && hasNoArguments(current)) {
        // A group command with no positionals of its own: this token is an
        // unknown command, and everything after it is unclassifiable.
        unknownCommand = true;
      }
      atLeaf = true;
    }

    positionals.push(arg);
    i++;
  }

  const declared = unknownCommand ? [] : current.getArguments();
  const recordedPositionals = positionals.map((value, index) => {
    if (value === REDACTED) return REDACTED;
    const argument = declared[index] ??
      (declared.at(-1)?.variadic ? declared.at(-1) : undefined);
    if (argument === undefined) return REDACTED;
    return isSentArgument(argument.name, commandPath) ? value : REDACTED;
  });

  const result: CommandInvocationData = {
    command: typedPath[0] ?? "",
    args: [...typedPath.slice(2), ...recordedPositionals],
    optionKeys,
    globalOptions,
    commandPath,
  };
  if (typedPath[1] !== undefined) {
    result.subcommand = typedPath[1];
  }
  return result;
}

function hasNoArguments(command: AnyCommand): boolean {
  return command.getArguments().length === 0;
}

/**
 * Whether the option spelled `key` (e.g. `--repo-dir`, `-v`, `--no-color`)
 * takes the next token as its value.
 *
 * An option the tree does not know consumes the next token when it does not
 * look like an option: it may be a mistyped `--input secret=x`, and sending
 * the value as a positional would leak it.
 */
function optionConsumesNext(
  command: AnyCommand,
  key: string,
  next: string | undefined,
): boolean {
  if (next === undefined || next.startsWith("-")) return false;

  const option = findOption(command, key);
  if (option === undefined) return true;

  const valueArgs = option.args ?? [];
  if (valueArgs.length === 0) return false;
  if (valueArgs.every((a) => a.optional)) {
    // An optional value is taken only if the token is not a command word.
    return command.getCommand(next, true) === undefined;
  }
  return true;
}

function findOption(command: AnyCommand, key: string) {
  const name = key.replace(/^--?/, "");
  return command.getOption(name, true) ??
    (name.startsWith("no-")
      ? command.getOption(name.slice(3), true)
      : undefined);
}
