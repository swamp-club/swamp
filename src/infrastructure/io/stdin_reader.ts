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

/**
 * Reads content from stdin if data is available.
 *
 * Returns null if stdin is a TTY (interactive mode) or if no data is available.
 * Returns the content as a string if data was piped to stdin.
 *
 * This allows commands to auto-detect piped input without requiring flags.
 *
 * @example
 * ```ts
 * const stdinContent = await readStdin();
 * if (stdinContent !== null) {
 *   // Process piped content
 *   const data = parseYaml(stdinContent);
 * } else {
 *   // Continue with interactive mode
 * }
 * ```
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
