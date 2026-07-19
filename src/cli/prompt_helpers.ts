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

/**
 * Shared interactive prompt helpers for CLI commands.
 *
 * These thin wrappers over raw stdin/stdout keep the prompt UX
 * consistent across every command that needs user confirmation or
 * free-text input.
 */

import { UserError } from "../domain/errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assertInteractiveStdin(): void {
  try {
    if (!Deno.stdin.isTerminal()) {
      throw new UserError(
        "stdin is not a terminal — use the confirmation-skip flag (e.g. --force or --yes) to run non-interactively",
      );
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      "stdin is not a terminal — use the confirmation-skip flag (e.g. --force or --yes) to run non-interactively",
    );
  }
}

/**
 * Prompt for a single line of text input.
 * Returns the trimmed response, or an empty string on EOF.
 */
export async function promptLine(message: string): Promise<string> {
  await Deno.stdout.write(encoder.encode(message));
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return "";
  return decoder.decode(buf.subarray(0, n)).trim();
}

/**
 * Prompt for a yes/no confirmation.
 * Appends ` [y/N] ` to the message. Returns `true` for "y" or "yes"
 * (case-insensitive), `false` otherwise (including EOF).
 */
export async function promptConfirmation(message: string): Promise<boolean> {
  assertInteractiveStdin();
  const response = await promptLine(`${message} [y/N] `);
  if (response === "") return false;
  return response.toLowerCase() === "y" ||
    response.toLowerCase() === "yes";
}

/**
 * Prompt the user to choose from a numbered list of options.
 * An extra "Other path" option is appended; selecting it prompts for
 * a free-text path. Returns the chosen string.
 */
export async function promptChoice(
  message: string,
  choices: string[],
): Promise<string> {
  assertInteractiveStdin();
  while (true) {
    await Deno.stdout.write(encoder.encode(`${message}\n`));
    for (let i = 0; i < choices.length; i++) {
      await Deno.stdout.write(
        encoder.encode(`  ${i + 1}. ${choices[i]}\n`),
      );
    }
    const response = await promptLine("> ");
    const index = parseInt(response, 10) - 1;
    if (index >= 0 && index < choices.length) {
      return choices[index];
    }
    if (response === "") return choices[0];
    await Deno.stdout.write(
      encoder.encode(`Invalid choice. Please enter 1-${choices.length}.\n`),
    );
  }
}

/**
 * Like {@link promptLine} but displays a default value and returns it
 * when the user presses Enter without typing anything.
 */
export async function promptLineWithDefault(
  message: string,
  defaultValue: string,
): Promise<string> {
  const response = await promptLine(`${message} (default: ${defaultValue}) `);
  return response === "" ? defaultValue : response;
}
