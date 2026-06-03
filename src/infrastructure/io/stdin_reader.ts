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
 * Reads all content from stdin until EOF.
 *
 * Returns null if stdin is a TTY. Callers should gate invocation behind
 * an explicit `--stdin` flag to avoid blocking on pipes that never close.
 */
export async function readStdin(): Promise<string | null> {
  // If stdin is a TTY, no piped data available
  if (Deno.stdin.isTerminal()) {
    return null;
  }

  const reader = Deno.stdin.readable.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) {
    return null;
  }

  // Concatenate all chunks into a single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  const decoder = new TextDecoder();
  return decoder.decode(result);
}

/**
 * Reads a secret value from a TTY with echo suppression.
 *
 * Prompts the user and reads input character-by-character without echoing
 * to the terminal. Supports backspace and Ctrl-C to cancel.
 *
 * Must only be called when stdin is a TTY (interactive terminal).
 *
 * @throws {Error} If the user cancels with Ctrl-C (throws with message "Cancelled.")
 */
export async function readSecretFromTty(prompt: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(prompt));

  Deno.stdin.setRaw(true);
  try {
    const chars: number[] = [];
    const buf = new Uint8Array(1);
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      // Enter key
      if (buf[0] === 13 || buf[0] === 10) break;
      // Backspace
      if (buf[0] === 127 || buf[0] === 8) {
        chars.pop();
        continue;
      }
      // Ctrl-C
      if (buf[0] === 3) {
        await Deno.stdout.write(encoder.encode("\n"));
        throw new Error("Cancelled.");
      }
      chars.push(buf[0]);
    }
    await Deno.stdout.write(encoder.encode("\n"));
    return decoder.decode(new Uint8Array(chars));
  } finally {
    Deno.stdin.setRaw(false);
  }
}
