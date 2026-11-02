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
  findMissingRequiredFields,
  isSecretLikeFieldName,
  type VaultConfigField,
} from "../domain/vaults/vault_config_fields.ts";
import type { OutputMode } from "../presentation/output/output.ts";
import { readSecretFromTty } from "../infrastructure/io/stdin_reader.ts";
import { promptLine } from "./prompt_helpers.ts";

const encoder = new TextEncoder();

/**
 * Whether a command may ask for config fields: only when a person is
 * there to answer. JSON output is for scripts, --yes asked for no
 * questions, and a non-terminal stdin has nobody behind it.
 */
export function canPromptForConfig(
  outputMode: OutputMode,
  options: { yes?: boolean } = {},
): boolean {
  if (outputMode !== "log" || options.yes) return false;
  try {
    return Deno.stdin.isTerminal();
  } catch {
    return false;
  }
}

export interface ConfigPromptIO {
  prompt: (message: string) => Promise<string>;
  /** Reads without echo, for a field that looks like a credential. */
  promptSecret: (message: string) => Promise<string>;
  /** Writes a line of explanation; prompts and notes go to stderr. */
  note: (line: string) => Promise<void>;
}

const defaultIO: ConfigPromptIO = {
  prompt: promptLine,
  promptSecret: readSecretFromTty,
  note: async (line) => {
    await Deno.stderr.write(encoder.encode(`${line}\n`));
  },
};

/**
 * a required field that is not a string is named as one to pass with --config;
 * a credential-looking field is read without echo; an empty answer is not
 * recorded so the type's schema still names whatever stays missing
 */
export async function promptForMissingConfigFields(
  vaultType: string,
  fields: readonly VaultConfigField[],
  config: Record<string, unknown>,
  io: ConfigPromptIO = defaultIO,
): Promise<Record<string, string>> {
  const missing = findMissingRequiredFields(fields, config);
  if (missing.length === 0) return {};

  const asked = missing.filter((f) => f.type === "string");
  const notAsked = missing.filter((f) => f.type !== "string");
  if (asked.length > 0) {
    await io.note(
      `${vaultType} needs these config fields. Press Enter to leave one unset.`,
    );
  }
  if (notAsked.length > 0) {
    await io.note(
      `Pass with --config: ${
        notAsked.map((f) => `${f.name} (${f.type})`).join(", ")
      }.`,
    );
  }

  const answers: Record<string, string> = {};
  for (const field of asked) {
    const secret = isSecretLikeFieldName(field.name);
    const detail = [
      ...(field.description ? [field.description] : []),
      ...(secret ? ["input hidden"] : []),
    ].join("; ");
    const label = detail ? `${field.name} (${detail}): ` : `${field.name}: `;
    const answer = secret
      ? await io.promptSecret(label)
      : await io.prompt(label);
    if (answer === "") continue;
    answers[field.name] = answer;
    if (secret) {
      await io.note(
        `Note: ${field.name} is saved as plain text in the vault's config file, which is tracked in git.`,
      );
    }
  }
  return answers;
}
