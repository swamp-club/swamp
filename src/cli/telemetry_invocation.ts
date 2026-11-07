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

import {
  type CommandInvocationData,
  isCommandSpelling,
} from "../domain/telemetry/mod.ts";
import { resolve } from "@std/path";
import type { AnyCommand } from "./cli_schema.ts";
import {
  behaviorTwinPath,
  isBehaviorGroupWord,
  isMethodLevelWord,
  MODEL_GROUP_WORD,
  MODEL_METHOD_WORD,
} from "./behavior_twin.ts";
import { GLOBAL_OPTIONS } from "./telemetry_integration.ts";

export const REDACTED = "<REDACTED>";

/**
 * names, ids, queries and types are how a user refers to things and are sent;
 * paths, input values and everything after data query are sensitive; an
 * unlisted name is redacted
 */
export const SENT_ARGUMENTS: ReadonlySet<string> = new Set([
  // the `swamp behavior` spellings of model_id_or_name, model_or_type and
  // output_id_or_model_name, classified the same way
  "behavior_id_or_name",
  "behavior_or_type",
  "collective",
  "data_name",
  "definition_name",
  "enabled",
  "extension",
  "grant_id",
  // `inbox read [message_id]`: an inbox message id, readable only by its
  // owner.
  "message_id",
  "method_name",
  "model_id_or_name",
  "model_or_type",
  "name",
  "new_name",
  "number",
  "old_name",
  "output_id",
  "output_id_or_behavior_name",
  "output_id_or_model_name",
  "query",
  "report_name",
  "run_id_or_workflow",
  "slug",
  "step_name",
  "token-id",
  // `datastore quarantine accept|discard <txn_id>`: a quarantined change's
  // txnId.
  "txn_id",
  "type",
  "vault_name",
  "vault_name_or_id",
  "version",
  "workflow_id_or_name",
  "workflow_name",
]);

/**
 * always redacted: paths, URLs, input values, the `data query` predicate,
 * access groups and principals, and free-form pass-through arguments
 */
export const REDACTED_ARGUMENTS: ReadonlySet<string> = new Set([
  // The hidden shell-completion command's action, called by completion scripts.
  "action",
  "args",
  // `access integration <verb> <id>`: an id the operator chose.
  "id",
  // `extension promote`: an extension name or a manifest path, so a path.
  "extension-or-manifest",
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
  // A signal wait's id is all `workflow signal` needs to answer the wait.
  "wait_id",
]);

/**
 * a value is sent only while it resolves as a command word walking the tree
 * from the root; people paste whole command lines after `help`, secrets
 * included, so everything from the first non-command word on is redacted
 */
export const COMMAND_WORD_ARGUMENTS: ReadonlySet<string> = new Set([
  "command",
]);

export const UNKNOWN_OPTION = "<UNKNOWN_OPTION>";

/**
 * `key` is a config setting name under `swamp config` (system-defined) but a
 * secret's name under `swamp vault`; every positional under `swamp access
 * group` names a group or member and is redacted
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
 * command and subcommand keep the typed spelling since swamp-club scores on
 * them and an alias can differ; anything unmatched is redacted, and with fewer
 * positionals than required all are
 */
export function resolveTelemetryInvocation(
  root: AnyCommand,
  args: string[],
  sensitiveValues: string[] = [],
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
      for (let j = i + 1; j < args.length; j++) {
        positionals.push(REDACTED);
        sensitiveValues.push(args[j]);
      }
      break;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg : arg.slice(0, eq);
      const recordedKey = optionKeyToRecord(current, key);
      recordOption(recordedKey);
      if (recordedKey === UNKNOWN_OPTION) sensitiveValues.push(key);
      if (eq !== -1) sensitiveValues.push(arg.slice(eq + 1));
      if (eq === -1 && optionConsumesNext(current, key, args[i + 1])) {
        if (findOption(current, key) === undefined) positionsUntrusted = true;
        sensitiveValues.push(args[i + 1]);
        i++;
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
  // with `missing` declared arguments not given, positional i may belong to any
  // of declared[i..i+missing] (`vault put DB_PASSWORD hunter2`); send it only
  // if every candidate slot is sent
  const missing = Math.max(0, declared.length - positionals.length);
  const commandWords = commandWordFlags(root, positionals);
  const recordedPositionals = positionals.map((value, index) => {
    const recorded = recordPositional(value, index);
    if (recorded === REDACTED && value !== REDACTED) {
      sensitiveValues.push(value);
    }
    return recorded;
  });
  function recordPositional(value: string, index: number): string {
    if (underfilled || positionsUntrusted) return REDACTED;
    if (value === REDACTED) return REDACTED;
    const last = declared.length - 1;
    if (index > last && !declared.at(-1)?.variadic) return REDACTED;
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
  }

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
 * swamp behavior and behaviour record as the equivalent swamp model invocation
 * so one command counts the same however typed; the typed root word is kept in
 * commandSpelling
 */
export function toRecordedInvocation(
  resolved: CommandInvocationData,
): CommandInvocationData {
  const path = resolved.commandPath ?? [];
  if (path[0] === MODEL_GROUP_WORD) {
    return { ...resolved, commandSpelling: MODEL_GROUP_WORD };
  }
  if (!isBehaviorGroupWord(path[0])) return resolved;

  const recorded: CommandInvocationData = {
    command: MODEL_GROUP_WORD,
    args: [...resolved.args],
    optionKeys: resolved.optionKeys,
    globalOptions: resolved.globalOptions,
    commandPath: behaviorTwinPath(path),
  };
  if (resolved.subcommand !== undefined) {
    if (isMethodLevelWord(path[1])) {
      recorded.subcommand = MODEL_METHOD_WORD;
      recorded.args = [resolved.subcommand, ...resolved.args];
    } else {
      recorded.subcommand = resolved.subcommand;
    }
  }
  recorded.commandSpelling = isCommandSpelling(resolved.command)
    ? resolved.command
    : "behavior";
  return recorded;
}

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
 * an unknown option consumes the next token unless it looks like an option,
 * since a mistyped --input secret=x would leak the value as a positional;
 * empty_option_value.ts walks argv the same way
 */
export function optionConsumesNext(
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
 * anything not declared is recorded as UNKNOWN_OPTION: a mistyped `--inptu` and
 * a value like `--sk-live-abc123` typed where no option expects one look the
 * same
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

export function findOption(command: AnyCommand, key: string) {
  const name = key.replace(/^--?/, "");
  return command.getOption(name, true) ??
    (name.startsWith("no-")
      ? command.getOption(name.slice(3), true)
      : undefined);
}

export interface InvocationLocations {
  cwd: string;
  home?: string;
  repoDir?: string;
}

/**
 * scrubbed exactly before patterns run: every redacted value (also absolute),
 * plus working, home and repo directories; bare numbers and booleans are
 * dropped as they would erase unrelated text
 */
export function buildKnownSensitiveValues(
  sensitiveValues: readonly string[],
  locations: InvocationLocations,
): string[] {
  const known = new Set<string>();
  for (const value of sensitiveValues) {
    if (value.length < 3 || /^\d+$/.test(value)) continue;
    if (value === "true" || value === "false") continue;
    known.add(value);
    // Any value may be a relative file name (`final report.yaml`); errors
    // usually print it resolved against the working directory.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      const expanded = locations.home && value.startsWith("~")
        ? locations.home + value.slice(1)
        : value;
      known.add(resolve(locations.cwd, expanded));
    }
  }
  for (const location of [locations.cwd, locations.home, locations.repoDir]) {
    if (location && location.length > 1) known.add(location);
  }
  return [...known];
}
