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
  const suggestions = buildContextSuggestions(unknownName, cmd);

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
): string[] {
  const suggestions: string[] = [];
  const parentName = cmd.getName();

  // Collect remaining args from the command path onward
  // (we don't have access to original args here, so use the unknown name itself)

  if (parentName === "model") {
    suggestions.push(
      `swamp model get ${unknownName}`,
    );
    suggestions.push(
      `swamp model method run ${unknownName} <method>`,
    );
    suggestions.push(
      `swamp model validate ${unknownName}`,
    );
  } else if (parentName === "method") {
    suggestions.push(
      `swamp model method run ${unknownName} <method>`,
    );
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
): string[] {
  const pathSegments = commandPath.split(" ");
  let i = 0;
  for (const segment of pathSegments) {
    while (i < rawArgs.length && rawArgs[i].startsWith("-")) {
      i++;
      if (i < rawArgs.length && !rawArgs[i].startsWith("-")) {
        i++;
      }
    }
    if (i < rawArgs.length && rawArgs[i] === segment) {
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
 * Builds a helpful error message when a command receives too many positional
 * arguments — typically because the user passed an unquoted multi-word value.
 */
export function buildTooManyArgumentsMessage(
  cmd: Command,
  rawArgs: string[],
): string {
  const commandPath = cmd.getPath();
  const positional = extractPositionalArgs(rawArgs, commandPath);
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
 * Cliffy error handler that intercepts "Unknown command" and "Too many
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
        const message = buildUnknownCommandMessage(unknownName, cmd);
        if (getOutputModeFromArgs(Deno.args) === "json") {
          const jsonError = buildErrorJson(new Error(message));
          // deno-lint-ignore no-console
          console.error(JSON.stringify(jsonError, null, 2));
          Deno.exit(2);
        }
        console.error(red(`error: ${message}`));
        Deno.exit(2);
      }
    }

    if (error.message.startsWith("Too many arguments")) {
      const message = buildTooManyArgumentsMessage(cmd, Deno.args);
      if (getOutputModeFromArgs(Deno.args) === "json") {
        const jsonError = buildErrorJson(new Error(message));
        // deno-lint-ignore no-console
        console.error(JSON.stringify(jsonError, null, 2));
        Deno.exit(2);
      }
      console.error(red(`error: ${message}`));
      Deno.exit(2);
    }
  }
  throw error;
}
