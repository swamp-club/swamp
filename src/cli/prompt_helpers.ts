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
 * prompts go to stderr, never stdout: stdout belongs to the command's result,
 * and a prompt in a value-carrying command's stdout corrupts it. The stdin gate
 * does not help, since redirecting stdout leaves stdin unchanged
 */

import { UserError } from "../domain/errors.ts";
import { writeHeldOutput } from "./committed_output.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assertInteractiveStdin(): void {
  try {
    if (!Deno.stdin.isTerminal()) {
      throw new UserError(
        "stdin is not a terminal — use --yes (-y) to skip confirmation prompts non-interactively",
      );
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      "stdin is not a terminal — use --yes (-y) to skip confirmation prompts non-interactively",
    );
  }
}

export async function promptLine(message: string): Promise<string> {
  return (await readLine(message)) ?? "";
}

async function readLine(message: string): Promise<string | null> {
  writeHeldOutput();
  await Deno.stderr.write(encoder.encode(message));
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return null;
  return decoder.decode(buf.subarray(0, n)).trim();
}

async function writeLines(lines: string[]): Promise<void> {
  writeHeldOutput();
  for (const line of lines) {
    await Deno.stderr.write(encoder.encode(`${line}\n`));
  }
}

export async function promptConfirmation(
  message: string,
  details: string[] = [],
): Promise<boolean> {
  assertInteractiveStdin();
  await writeLines(details);
  const response = await promptLine(`${message} [y/N] `);
  if (response === "") return false;
  return response.toLowerCase() === "y" ||
    response.toLowerCase() === "yes";
}

export async function promptChoice(
  message: string,
  choices: string[],
): Promise<string> {
  assertInteractiveStdin();
  writeHeldOutput();
  while (true) {
    await Deno.stderr.write(encoder.encode(`${message}\n`));
    for (let i = 0; i < choices.length; i++) {
      await Deno.stderr.write(
        encoder.encode(`  ${i + 1}. ${choices[i]}\n`),
      );
    }
    const response = await promptLine("> ");
    const index = parseInt(response, 10) - 1;
    if (index >= 0 && index < choices.length) {
      return choices[index];
    }
    if (response === "") return choices[0];
    await Deno.stderr.write(
      encoder.encode(`Invalid choice. Please enter 1-${choices.length}.\n`),
    );
  }
}

/**
 * Enter or an answer outside the list asks again so nothing is chosen by
 * accident; null on EOF is the answer callers treat as changing nothing
 */
export async function promptNumberedChoice(
  details: string[],
  choices: string[],
): Promise<number | null> {
  assertInteractiveStdin();
  await writeLines(details);
  await writeLines(choices.map((choice, i) => `  ${i + 1}. ${choice}`));
  const range = choices.map((_, i) => i + 1).join("/");
  while (true) {
    const response = await readLine(`Choose [${range}]: `);
    if (response === null) return null;
    const index = Number(response) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) {
      return index;
    }
    await Deno.stderr.write(
      encoder.encode(
        `Please enter ${choices.map((_, i) => i + 1).join(", ")}.\n`,
      ),
    );
  }
}

export async function promptLineWithDefault(
  message: string,
  defaultValue: string,
): Promise<string> {
  const response = await promptLine(`${message} (default: ${defaultValue}) `);
  return response === "" ? defaultValue : response;
}
