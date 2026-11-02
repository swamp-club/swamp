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
import { readDirSorted } from "../../infrastructure/persistence/sorted_dir_entries.ts";

/**
 * reads each directory in name order so the same tree always names the same
 * link; an extension never holds a link
 */
export async function firstSymlinkUnder(
  dir: string,
): Promise<string | undefined> {
  for (const entry of await readDirSorted(dir)) {
    const path = join(dir, entry.name);
    if (entry.isSymlink) return path;
    if (entry.isDirectory) {
      const found = await firstSymlinkUnder(path);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
