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

import type { ParsedCommand } from "./types.ts";

/**
 * Shortcut aliases that map a single word to a domain + verb.
 * e.g., `/run deploy` → domain: "workflow", verb: "run", target: "deploy"
 */
const SHORTCUTS: ReadonlyMap<string, { domain: string; verb: string }> =
  new Map([
    ["run", { domain: "workflow", verb: "run" }],
    ["status", { domain: "auth", verb: "whoami" }],
    ["search", { domain: "data", verb: "search" }],
  ]);

/**
 * Known domain + verb pairs that map to libswamp operations.
 */
const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  "workflow.run",
  "workflow.search",
  "workflow.get",
  "workflow.validate",
  "model.search",
  "model.get",
  "data.list",
  "data.search",
  "data.get",
  "auth.whoami",
]);

/**
 * Parse a chat message into a structured command.
 *
 * Supported formats:
 * - `/swamp workflow run deploy --input env=prod`
 * - `/run deploy --input env=prod` (shortcut)
 * - `workflow run deploy` (bare, when @mentioned)
 *
 * Returns null if the message is not a recognizable command.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return null;

  // Extract options (--key=value or --key value pairs)
  const { positional, options } = extractOptions(tokens);
  if (positional.length === 0) return null;

  // Strip leading /swamp or / prefix
  let cursor = 0;
  let first = positional[cursor];

  // Remove leading slash
  if (first.startsWith("/")) {
    first = first.slice(1);
    if (first === "swamp") {
      cursor++;
      if (cursor >= positional.length) return null;
      first = positional[cursor];
    }
  }

  // Try shortcut: /run deploy
  const shortcut = SHORTCUTS.get(first);
  if (shortcut) {
    const target = positional[cursor + 1] ?? "";
    return {
      domain: shortcut.domain,
      verb: shortcut.verb,
      target,
      options,
      raw: trimmed,
    };
  }

  // Try full form: workflow run deploy
  const domain = first;
  const verb = positional[cursor + 1];
  if (!verb) return null;

  const commandKey = `${domain}.${verb}`;
  if (!KNOWN_COMMANDS.has(commandKey)) return null;

  const target = positional[cursor + 2] ?? "";
  return {
    domain,
    verb,
    target,
    options,
    raw: trimmed,
  };
}

/** Split text into tokens, respecting quoted strings. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const char of text) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/** Separate positional arguments from --key=value options. */
function extractOptions(
  tokens: string[],
): { positional: string[]; options: ReadonlyMap<string, string> } {
  const positional: string[] = [];
  const options = new Map<string, string>();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const withoutDashes = token.slice(2);
      const eqIndex = withoutDashes.indexOf("=");
      if (eqIndex !== -1) {
        options.set(
          withoutDashes.slice(0, eqIndex),
          withoutDashes.slice(eqIndex + 1),
        );
      } else {
        // Next token is the value
        const value = tokens[i + 1];
        if (value && !value.startsWith("--")) {
          options.set(withoutDashes, value);
          i++;
        } else {
          options.set(withoutDashes, "true");
        }
      }
    } else {
      positional.push(token);
    }
  }

  return { positional, options };
}
