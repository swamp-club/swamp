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
  // The hidden shell-completion command's action, called by completion scripts.
  "action",
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
 * Arguments that name commands (`help [command...]`). A value is sent only
 * while it resolves as a command word walking the tree from the root — people
 * paste whole command lines after `help`, secrets and predicates included —
 * and everything from the first non-command word on is redacted.
 */
export const COMMAND_WORD_ARGUMENTS: ReadonlySet<string> = new Set([
  "command",
]);

/** Recorded in place of an option key that is neither declared nor option-shaped. */
export const UNKNOWN_OPTION = "<UNKNOWN_OPTION>";

/**
 * Whether a positional declared as `argName` is sent under `commandPath`.
 *
 * Two names depend on the command:
 * - `key` is a config setting name under `swamp config` — system-defined — but
 *   a secret's name under `swamp vault`, which is an input value.
 * - Every positional under `swamp access group` names a group or a member, and
 *   both are redacted — `access group create <name>` declares the group as a
 *   plain `name`.
 */
export function isSentArgument(
  argName: string,
  commandPath: string[],
): boolean {
  if (commandPath[0] === "access" && commandPath[1] === "group") return false;
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
 * this also records invocations that failed to parse. When fewer positionals
 * are given than the command requires, the index mapping cannot be trusted
 * (`vault put KEY=VALUE` would put the secret in the vault-name slot), so
 * every positional is redacted.
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
  // An unknown option that swallowed a token may have taken a positional,
  // shifting every later one into the wrong slot.
  let positionsUntrusted = false;

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
      recordOption(optionKeyToRecord(current, key));
      if (eq === -1 && optionConsumesNext(current, key, args[i + 1])) {
        if (findOption(current, key) === undefined) positionsUntrusted = true;
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
  const required = declared.filter((a) => !a.optional).length;
  const underfilled = positionals.length < required;
  // With `missing` declared arguments not given, positional i may really
  // belong to any of declared[i..i+missing] — `vault put DB_PASSWORD hunter2`
  // is `<vault_name> <key>` or `<key> <value>`. Send it only if every
  // candidate slot is sent.
  const missing = Math.max(0, declared.length - positionals.length);
  const commandWords = commandWordFlags(root, positionals);
  const recordedPositionals = positionals.map((value, index) => {
    if (underfilled || positionsUntrusted) return REDACTED;
    if (value === REDACTED) return REDACTED;
    const last = declared.length - 1;
    if (index > last && !declared.at(-1)?.variadic) return REDACTED;
    // Beyond the last slot, a variadic argument repeats.
    const first = Math.min(index, last);
    for (let slot = first; slot <= Math.min(first + missing, last); slot++) {
      const name = declared[slot].name;
      if (COMMAND_WORD_ARGUMENTS.has(name)) {
        if (!commandWords[index]) return REDACTED;
      } else if (!isSentArgument(name, commandPath)) {
        return REDACTED;
      }
    }
    return value;
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

/**
 * For each positional, whether it and every positional before it resolve as
 * command words walking the tree from the root.
 */
function commandWordFlags(root: AnyCommand, positionals: string[]): boolean[] {
  let cursor: AnyCommand | undefined = root;
  return positionals.map((value) => {
    cursor = cursor?.getCommand(value, true);
    return cursor !== undefined;
  });
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
  if (next === undefined) return false;

  const option = findOption(command, key);
  if (option === undefined) {
    // Combined short flags (`-vq`) take no value when every letter is a
    // known flag that takes none, and a command word is never a value.
    if (isCombinedShortFlags(command, key)) return false;
    return !next.startsWith("-") &&
      command.getCommand(next, true) === undefined;
  }

  const valueArgs = option.args ?? [];
  if (valueArgs.length === 0) return false;
  if (valueArgs.every((a) => a.optional)) {
    // An optional value is taken only if the token is not an option or a
    // command word.
    return !next.startsWith("-") &&
      command.getCommand(next, true) === undefined;
  }
  // A required value is always the next token, even one starting with `-`
  // (`--input -hunter2`) — otherwise the value is recorded as an option key.
  return true;
}

/**
 * The option key to record. A declared option is recorded as typed. Anything
 * else is recorded as {@link UNKNOWN_OPTION}: a mistyped `--inptu` and a value
 * such as `--sk-live-abc123` typed where no option expects one look the same.
 */
function optionKeyToRecord(command: AnyCommand, key: string): string {
  if (
    findOption(command, key) !== undefined ||
    isCombinedShortFlags(command, key)
  ) {
    return key;
  }
  return UNKNOWN_OPTION;
}

function isCombinedShortFlags(command: AnyCommand, key: string): boolean {
  if (!/^-[a-zA-Z]{2,}$/.test(key)) return false;
  return [...key.slice(1)].every((letter) => {
    const option = command.getOption(letter, true);
    return option !== undefined && (option.args ?? []).length === 0;
  });
}

function findOption(command: AnyCommand, key: string) {
  const name = key.replace(/^--?/, "");
  return command.getOption(name, true) ??
    (name.startsWith("no-")
      ? command.getOption(name.slice(3), true)
      : undefined);
}
