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

import { dirname } from "@std/path";

/**
 * Creates `dir` and any missing directory above it, one level at a time, as
 * a recursive mkdir would. With `syncDirectory`, the parent of each
 * directory created here is synced before this resolves, so its entry is
 * durable (swamp-club#4017): a directory sync makes the directory's own
 * entries durable, not its entry in its parent. A directory a concurrent
 * writer created is left to that writer.
 *
 * A parent that exists but is not a usable directory (a dangling symlink,
 * or a file on Windows) rejects, as a recursive mkdir does, rather than
 * being retried forever.
 */
export async function makeDirectories(
  dir: string,
  syncDirectory?: (dir: string) => Promise<void>,
): Promise<void> {
  const created: string[] = [];
  const pending = [dir];
  // Parents already made or found present. A child that still reports
  // NotFound under one would otherwise retry forever; it throws.
  const attempted = new Set<string>();
  while (pending.length > 0) {
    const next = pending[pending.length - 1];
    try {
      await Deno.mkdir(next);
      created.push(next);
      pending.pop();
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        pending.pop();
        continue;
      }
      const parent = dirname(next);
      if (
        !(error instanceof Deno.errors.NotFound) || parent === next ||
        attempted.has(parent)
      ) {
        throw error;
      }
      attempted.add(parent);
      pending.push(parent);
    }
  }
  if (syncDirectory === undefined || created.length === 0) return;
  const parents = [...new Set(created.map((d) => dirname(d)))];
  // Every sync settles before the first failure is rethrown.
  for (const result of await Promise.allSettled(parents.map(syncDirectory))) {
    if (result.status === "rejected") throw result.reason;
  }
}
