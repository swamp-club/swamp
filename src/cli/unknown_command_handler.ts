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

import { type Command, ValidationError } from "@cliffy/command";
import { red } from "@std/fmt/colors";
import { findClosestMatch } from "../domain/string_distance.ts";
import { getOutputModeFromArgs } from "./context.ts";
import { buildErrorJson } from "../presentation/output/error_output.ts";
import { takeAuthGateWarning } from "../presentation/renderers/auth_gate_warning.ts";

/**
 * Extracts the unknown command name from a Cliffy "Unknown command" error message.
 *
 * Cliffy formats these as: `Unknown command "foo".` or `Unknown command "foo". Did you mean command "bar"?`
 */
export function extractUnknownName(errorMessage: string): string | undefined {
  const match = errorMessage.match(/^Unknown command "([^"]+)"/);
  return match?.[1];
}

/**
 * Gets the names of all visible subcommands for a given command.
 * Passing `false` to `getCommands` filters out hidden commands.
 */
export function getSubcommandNames(cmd: Command): string[] {
  return cmd.getCommands(false).map((c) => c.getName());
}

/**
 * Builds context-aware suggestions when a user provides an unknown subcommand.
 *
 * Instead of Cliffy's generic "Did you mean 'create'?", this produces
 * suggestions that match the user's likely intent based on the command context.
 */
export function buildUnknownCommandMessage(
  unknownName: string,
  cmd: Command,
  rawArgs: string[] = [],
): string {
  const subcommands = getSubcommandNames(cmd);
  const commandPath = cmd.getPath();

  // Check if the unknown name is a close typo of a real subcommand
  const typoMatch = findClosestMatch(unknownName, subcommands);
  if (typoMatch) {
    return `Unknown command "${unknownName}". Did you mean "${typoMatch}"?\n\n` +
      `  Run "${commandPath} --help" for available subcommands.`;
  }

  // Not a typo — build context-aware suggestions based on the command context
  const suggestions = buildContextSuggestions(unknownName, cmd, rawArgs);

  if (suggestions.length > 0) {
    const lines = [
      `"${unknownName}" is not a subcommand of "${cmd.getName()}".`,
      "",
      "  Did you mean one of these?",
      "",
      ...suggestions.map((s) => `    ${s}`),
      "",
      `  Run "${commandPath} --help" for available subcommands.`,
    ];
    return lines.join("\n");
  }

  // Generic fallback
  return `Unknown command "${unknownName}".\n\n` +
    `  Run "${commandPath} --help" for available subcommands.`;
}

/**
 * Builds context-specific suggestions based on which command the user is in.
 */
function buildContextSuggestions(
  unknownName: string,
  cmd: Command,
  rawArgs: string[] = [],
): string[] {
  const suggestions: string[] = [];
  const parentName = cmd.getName();

  // A legacy word under the new group, or the new word under the old one:
  // `swamp behavior method run p1 ping`, `swamp model run p1 ping`. The
  // positionals that follow are the model and method the user meant
  // (swamp-club#3265).
  if (
    (parentName === "behavior" && unknownName === "method") ||
    (parentName === "model" && unknownName === "run")
  ) {
    const trailing = extractPositionalArgs(
      rawArgs,
      `${cmd.getPath()} ${unknownName}`,
      [...pathSpellings(cmd), new Set([unknownName])],
    );
    const rest = trailing[0] === "run" ? trailing.slice(1) : trailing;
    suggestions.push(runSuggestionFor(rest[0] ?? "<model>", rest.slice(1)));
    return suggestions;
  }

  // `swamp behavior my-server deploy` — `run` left out. The positionals after
  // the unknown word are the method (and, for an `@type`, the name) the user
  // meant.
  const trailing = extractPositionalArgs(
    rawArgs,
    `${cmd.getPath()} ${unknownName}`,
    [...pathSpellings(cmd), new Set([unknownName])],
  );
  // `swamp model @type method ping name` — the legacy direct-type form with
  // `run` left out, which `rewriteDirectTypeArgs` does not rewrite. `method`
  // (and a `run` after it) is the command word, not the method the user meant.
  const legacyDirectType = parentName === "model" &&
    unknownName.startsWith("@") && trailing[0] === "method";
  // `swamp behavior my-server run deploy` — `run` after the model instead of
  // before it. Here too `run` is the command word, not the method.
  const misorderedRun = parentName === "behavior" && trailing[0] === "run";
  let afterCommandWords = trailing;
  if (legacyDirectType) {
    afterCommandWords = trailing.slice(trailing[1] === "run" ? 2 : 1);
  } else if (misorderedRun) {
    afterCommandWords = trailing.slice(1);
  }
  const runSuggestion = runSuggestionFor(unknownName, afterCommandWords);

  if (parentName === "model") {
    if (!unknownName.startsWith("@")) {
      suggestions.push(
        `swamp model get ${unknownName}`,
      );
    }
    suggestions.push(runSuggestion);
    if (!unknownName.startsWith("@")) {
      suggestions.push(
        `swamp model validate ${unknownName}`,
      );
    }
  } else if (parentName === "method" || parentName === "behavior") {
    suggestions.push(runSuggestion);
  } else if (parentName === "workflow") {
    suggestions.push(
      `swamp workflow get ${unknownName}`,
    );
    suggestions.push(
      `swamp workflow run ${unknownName}`,
    );
    suggestions.push(
      `swamp workflow validate ${unknownName}`,
    );
  } else if (parentName === "vault") {
    suggestions.push(
      `swamp vault get ${unknownName}`,
    );
    suggestions.push(
      `swamp vault put ${unknownName} <key> <value>`,
    );
    suggestions.push(
      `swamp vault list-keys ${unknownName}`,
    );
  } else if (parentName === "history") {
    suggestions.push(
      `swamp ... history get ${unknownName}`,
    );
    suggestions.push(
      `swamp ... history logs ${unknownName}`,
    );
    suggestions.push(
      `swamp ... history search`,
    );
  } else if (parentName === "output") {
    suggestions.push(
      `swamp model output get ${unknownName}`,
    );
    suggestions.push(
      `swamp model output search`,
    );
    suggestions.push(
      `swamp model output logs ${unknownName}`,
    );
  } else if (parentName === "extension") {
    suggestions.push(
      `swamp extension push ${unknownName}`,
    );
    suggestions.push(
      `swamp extension pull ${unknownName}`,
    );
  } else if (parentName === "repo") {
    suggestions.push(
      `swamp repo init ${unknownName}`,
    );
    suggestions.push(
      `swamp repo upgrade`,
    );
    suggestions.push(
      `swamp update`,
    );
  } else {
    // Generic: just list available subcommands
    const subcommands = getSubcommandNames(cmd);
    if (subcommands.length > 0) {
      const listed = subcommands.slice(0, 5).join(", ");
      suggestions.push(
        `Available subcommands: ${listed}${
          subcommands.length > 5 ? ", ..." : ""
        }`,
      );
    }
  }

  return suggestions;
}

/**
 * `swamp behavior run <model> <method>`, filled from what the user typed
 * after the model. An `@type` can only be run directly, and that form also
 * needs a definition name (swamp-club#3265).
 */
function runSuggestionFor(model: string, rest: string[]): string {
  const method = rest[0] ?? "<method>";
  if (!model.startsWith("@")) return `swamp behavior run ${model} ${method}`;
  return `swamp behavior run ${model} ${method} ${rest[1] ?? "<name>"}`;
}

/**
 * Extracts positional arguments from the raw CLI args for a given command path.
 *
 * Walks past the command-path segments, then collects non-flag tokens
 * (anything not starting with `-`). Flag *values* (the token after a
 * `--flag <value>` pair) are skipped by consuming the next token when a
 * flag is seen.
 */
export function extractPositionalArgs(
  rawArgs: string[],
  commandPath: string,
  spellings: ReadonlyArray<ReadonlySet<string>> = [],
): string[] {
  const pathSegments = commandPath.split(" ");
  let i = 0;
  for (const [index, segment] of pathSegments.entries()) {
    while (i < rawArgs.length && rawArgs[i].startsWith("-")) {
      i++;
      if (i < rawArgs.length && !rawArgs[i].startsWith("-")) {
        i++;
      }
    }
    if (
      i < rawArgs.length &&
      (rawArgs[i] === segment || spellings[index]?.has(rawArgs[i]))
    ) {
      i++;
    }
  }

  const positional: string[] = [];
  while (i < rawArgs.length) {
    if (rawArgs[i] === "--") {
      break;
    }
    if (rawArgs[i].startsWith("-")) {
      i++;
      if (i < rawArgs.length && !rawArgs[i].startsWith("-")) {
        i++;
      }
      continue;
    }
    positional.push(rawArgs[i]);
    i++;
  }
  return positional;
}

/**
 * The spellings each segment of `cmd`'s path may have been typed as — the
 * command's name and its aliases, root first. `cmd.getPath()` is the
 * canonical spelling, so without these an alias (`behaviour` for `behavior`)
 * would be taken for a positional (swamp-club#3265).
 */
function pathSpellings(cmd: Command): ReadonlySet<string>[] {
  const chain: Command[] = [];
  for (
    let current: Command | undefined = cmd;
    current;
    current = current.getParent()
  ) {
    chain.unshift(current);
  }
  return chain.map((c) => new Set([c.getName(), ...c.getAliases()]));
}

/**
 * Builds a helpful error message when a command receives too many positional
 * arguments — typically because the user passed an unquoted multi-word value.
 */
export function buildTooManyArgumentsMessage(
  cmd: Command,
  rawArgs: string[],
): string {
  const commandPath = cmd.getPath();
  const positional = extractPositionalArgs(
    rawArgs,
    commandPath,
    pathSpellings(cmd),
  );
  const quoted = positional.join(" ");

  if (positional.length >= 2) {
    return `Too many arguments.\n\n` +
      `  If your argument contains spaces, wrap it in quotes:\n` +
      `    ${commandPath} "${quoted}"`;
  }

  return `Too many arguments.\n\n` +
    `  Run "${commandPath} --help" for usage.`;
}

/**
 * When a group command is handed a positional that is not one of its
 * subcommands together with an option it does not declare — `swamp behavior
 * @acme/t run ping name --input k=v`, `swamp model p1 --input k=v` — Cliffy
 * reports the option before the command, so the user sees `Unknown option
 * "--input"` instead of the unknown-command suggestions. This finds that
 * positional so the handler can report it as the unknown command it is.
 *
 * Returns undefined, leaving Cliffy's message to stand, when the option
 * really is the problem: `cmd` has no subcommands; it declares positionals of
 * its own (`model output <id>`, `workflow history <name>`), so the positional
 * is legitimate; no positional was typed, or it is one of the subcommands; or
 * the option came before the positional (`behavior --skip-checks run …`),
 * where a flag read as taking a value would have swallowed the subcommand.
 */
export function unknownSubcommandBehindOption(
  cmd: Command,
  rawArgs: string[],
  errorMessage: string,
): string | undefined {
  if (cmd.getCommands(true).length === 0) return undefined;
  if (cmd.getArguments().length > 0) return undefined;
  const [first] = extractPositionalArgs(
    rawArgs,
    cmd.getPath(),
    pathSpellings(cmd),
  );
  if (first === undefined || cmd.getCommand(first, true)) return undefined;
  const option = errorMessage.match(/^Unknown option "([^"]+)"/)?.[1];
  const optionIndex = option === undefined
    ? -1
    : rawArgs.findIndex((arg) =>
      arg === option || arg.startsWith(`${option}=`)
    );
  if (optionIndex !== -1 && optionIndex < rawArgs.indexOf(first)) {
    return undefined;
  }
  return first;
}

function exitWithMessage(message: string): never {
  if (getOutputModeFromArgs(Deno.args) === "json") {
    const jsonError = buildErrorJson(new Error(message));
    Object.assign(jsonError, takeAuthGateWarning());
    // deno-lint-ignore no-console
    console.error(JSON.stringify(jsonError, null, 2));
    Deno.exit(2);
  }
  console.error(red(`error: ${message}`));
  Deno.exit(2);
}

/**
 * Cliffy error handler that intercepts "Unknown command", "Unknown option"
 * on a group that was really given an unknown command, and "Too many
 * arguments" errors and provides context-aware suggestions.
 *
 * Cliffy's `getErrorHandler()` only checks the current command and its
 * immediate parent, so this handler must be attached to each command that
 * should provide improved error messages.
 */
export function unknownCommandErrorHandler(error: Error, cmd: Command): void {
  if (error instanceof ValidationError) {
    if (error.message.startsWith("Unknown command")) {
      const unknownName = extractUnknownName(error.message);
      if (unknownName) {
        exitWithMessage(
          buildUnknownCommandMessage(unknownName, cmd, Deno.args),
        );
      }
    }

    if (error.message.startsWith("Unknown option")) {
      const unknownName = unknownSubcommandBehindOption(
        cmd,
        Deno.args,
        error.message,
      );
      if (unknownName) {
        exitWithMessage(
          buildUnknownCommandMessage(unknownName, cmd, Deno.args),
        );
      }
    }

    if (error.message.startsWith("Too many arguments")) {
      exitWithMessage(buildTooManyArgumentsMessage(cmd, Deno.args));
    }
  }
  throw error;
}
