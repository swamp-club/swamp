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

import { dirname, join } from "@std/path";

/**
 * Writes text content to a file atomically.
 *
 * Writes to a temporary file in the same directory, then renames to the
 * target path. This ensures the file is never left in a partially-written
 * state if the process crashes mid-write.
 *
 * @param path The target file path
 * @param content The text content to write
 */
export async function atomicWriteTextFile(
  path: string,
  content: string,
  options?: Deno.WriteFileOptions,
): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);

  try {
    await Deno.writeTextFile(tmpPath, content, options);
    await Deno.rename(tmpPath, path);
  } catch (error) {
    try {
      await Deno.remove(tmpPath);
    } catch {
      // Temp file may not exist if writeTextFile failed before creating it
    }
    throw error;
  }
}

/**
 * Writes binary content to a file atomically.
 *
 * Writes to a temporary file in the same directory, then renames to the
 * target path. This ensures the file is never left in a partially-written
 * state if the process crashes mid-write.
 *
 * @param path The target file path
 * @param content The binary content to write
 */
export async function atomicWriteFile(
  path: string,
  content: Uint8Array,
): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);

  try {
    await Deno.writeFile(tmpPath, content);
    await Deno.rename(tmpPath, path);
  } catch (error) {
    try {
      await Deno.remove(tmpPath);
    } catch {
      // Temp file may not exist if writeFile failed before creating it
    }
    throw error;
  }
}
