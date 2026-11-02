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
 * creates missing parents one level at a time; with syncDirectory each created
 * dir's parent is synced so its entry is durable. A dangling or non-directory
 * parent rejects instead of retrying
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
