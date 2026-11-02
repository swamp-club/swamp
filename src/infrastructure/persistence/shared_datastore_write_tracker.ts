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

import { join } from "@std/path";

export const CATALOG_WRITERS_DIR = ".catalog-writers";

const TEMP_SUFFIX = ".tmp";

/**
 * each catalog rewrites its own token file after each data write and readers
 * invalidate when others' tokens change; plain files only, as SQLite WAL is
 * unsafe on network filesystems
 */
export class SharedDatastoreWriteTracker {
  constructor(private readonly dir: string) {}

  recordWrite(writerId: string): void {
    Deno.mkdirSync(this.dir, { recursive: true });
    const target = join(this.dir, writerId);
    const temp = `${target}.${crypto.randomUUID()}${TEMP_SUFFIX}`;
    Deno.writeTextFileSync(temp, crypto.randomUUID());
    try {
      Deno.renameSync(temp, target);
    } catch (error) {
      try {
        Deno.removeSync(temp);
      } catch {
        // Keep the rename error; a stray temp file is skipped by readers.
      }
      throw error;
    }
  }

  /**
   * serialised in a stable order so the result can be stored and compared as a
   * string
   */
  foreignTokens(writerId: string): string {
    const tokens: Record<string, string> = {};
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(this.dir)];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return "{}";
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile) continue;
      if (entry.name === writerId || entry.name.endsWith(TEMP_SUFFIX)) continue;
      try {
        tokens[entry.name] = Deno.readTextFileSync(join(this.dir, entry.name));
      } catch (error) {
        // The writer replaced or removed its token between the listing and
        // the read; the next check sees its new state.
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    const sorted = Object.keys(tokens).sort().map((k) => [k, tokens[k]]);
    return JSON.stringify(Object.fromEntries(sorted));
  }
}
