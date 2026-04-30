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
 * Number of retry attempts on Windows EBUSY before giving up.
 * Total wait time across all retries: 50+100+150+200+250 = 750ms.
 */
const MAX_EBUSY_RETRIES = 5;

/**
 * Remove a path with bounded retry on Windows EBUSY errors.
 *
 * Windows refuses to delete files that have active handles, returning
 * EBUSY (os error 32). Even briefly-closed handles can linger due to
 * OS-level lazy release (antivirus scanning, file-system cache, JS
 * garbage-collection finalizers for native bindings such as `node:sqlite`).
 *
 * On POSIX (linux, darwin, etc.) `unlink()` of an open file is permitted —
 * the directory entry is removed and the file content stays accessible
 * until the last fd closes — so EBUSY does not arise. The retry path is
 * unreachable on POSIX; this function delegates directly to `Deno.remove`
 * with no observable behaviour change.
 *
 * On Windows: up to {@link MAX_EBUSY_RETRIES} retries with linear backoff
 * (50ms, 100ms, 150ms, 200ms, 250ms) for a total max wait of ~750ms.
 * Non-EBUSY errors propagate immediately. After retry exhaustion, the
 * original EBUSY error is re-thrown so the failure signal is preserved.
 */
export async function removeWithRetry(
  path: string | URL,
  options?: Deno.RemoveOptions,
): Promise<void> {
  if (Deno.build.os !== "windows") {
    return await Deno.remove(path, options);
  }
  for (let attempt = 0; attempt <= MAX_EBUSY_RETRIES; attempt++) {
    try {
      await Deno.remove(path, options);
      return;
    } catch (error) {
      const code = error instanceof Error
        ? (error as Error & { code?: string }).code
        : undefined;
      if (code !== "EBUSY" || attempt === MAX_EBUSY_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
