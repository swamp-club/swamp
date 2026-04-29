// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Extracts the unknown option name from a Cliffy "Unknown option" error message.
 *
 * Cliffy formats these as: `Unknown option "--foo".` or
 * `Unknown option "--foo". Did you mean option "--bar"?`
 */
export function extractUnknownOption(
  errorMessage: string,
): string | undefined {
  const match = errorMessage.match(/^Unknown option "([^"]+)"/);
  return match?.[1];
}

/**
 * Maps common option-name guesses to the canonical swamp flag(s). Used to
 * suggest the correct flag when a user types something semantically near
 * the right name but lexically distant — e.g. `--arg` is closer to `--log`
 * (3 chars) than `--input` (5 chars), so cliffy's edit-distance default
 * picks the wrong one.
 *
 * Suggestions in this map are filtered down to those actually defined on
 * the command before being shown.
 */
const SEMANTIC_OPTION_ALIASES: Record<string, readonly string[]> = {
  "--arg": ["--input", "--global-arg"],
  "--args": ["--input", "--global-arg"],
  "--global-args": ["--global-arg"],
  "--inputs": ["--input"],
  "--param": ["--input", "--global-arg"],
  "--params": ["--input", "--global-arg"],
};

/**
 * Returns all option names defined on a command, including aliases, in
 * `--flag` form. Hidden options are excluded so suggestions only point at
 * documented flags.
 */
function getOptionFlagNames(cmd: Command): string[] {
  const names: string[] = [];
  for (const opt of cmd.getOptions(false)) {
    names.push(`--${opt.name}`);
    for (const alias of opt.aliases ?? []) {
      // Cliffy aliases are stored without the leading dashes for long
      // options and as single chars for short options.
      names.push(alias.length === 1 ? `-${alias}` : `--${alias}`);
    }
  }
  return names;
}

/**
 * Builds a human-readable message for an unknown CLI option. Prefers a
 * semantic alias match (e.g. `--arg` → `--input`) over cliffy's default
 * edit-distance match, which is purely lexical.
 */
export function buildUnknownOptionMessage(
  unknownOption: string,
  cmd: Command,
): string {
  const available = getOptionFlagNames(cmd);
  const commandPath = cmd.getPath();

  const semanticCandidates = SEMANTIC_OPTION_ALIASES[unknownOption] ?? [];
  const semanticMatches = semanticCandidates.filter((c) =>
    available.includes(c)
  );

  // Fall back to closest lexical match if no semantic alias applies.
  const lexicalMatch = semanticMatches.length === 0
    ? findClosestMatch(unknownOption, available)
    : undefined;

  const suggestions = semanticMatches.length > 0
    ? semanticMatches
    : lexicalMatch
    ? [lexicalMatch]
    : [];

  if (suggestions.length === 0) {
    return `Unknown option "${unknownOption}".\n\n` +
      `  Run "${commandPath} --help" to see available options.`;
  }

  const quoted = suggestions.map((s) => `"${s}"`);
  const suggestionLine = quoted.length === 1
    ? `Did you mean ${quoted[0]}?`
    : `Did you mean one of: ${quoted.join(", ")}?`;

  return `Unknown option "${unknownOption}". ${suggestionLine}\n\n` +
    `  Run "${commandPath} --help" to see available options.`;
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
  } else if (parentName === "extension") {
    suggestions.push(
      `swamp extension push ${unknownName}`,
    );
    suggestions.push(
      `swamp extension pull ${unknownName}`,
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
 * Cliffy error handler that intercepts "Unknown command" errors and provides
 * context-aware suggestions.
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
        emitFormattedError(
          buildUnknownCommandMessage(unknownName, cmd),
        );
      }
    } else if (error.message.startsWith("Unknown option")) {
      const unknownOption = extractUnknownOption(error.message);
      if (unknownOption) {
        emitFormattedError(
          buildUnknownOptionMessage(unknownOption, cmd),
        );
      }
    }
  }
  throw error;
}

function emitFormattedError(message: string): never {
  if (getOutputModeFromArgs(Deno.args) === "json") {
    const jsonError = buildErrorJson(new Error(message));
    // deno-lint-ignore no-console
    console.log(JSON.stringify(jsonError, null, 2));
  }
  console.error(red(`error: ${message}`));
  Deno.exit(2);
}
