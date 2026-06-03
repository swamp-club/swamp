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
import type {
  UpdateCheckCacheData,
  UpdateCheckCacheRepository,
} from "../../domain/update/update_check_cache.ts";
import { getSwampDataDir } from "../persistence/paths.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

const CACHE_FILE_NAME = "last-update-check.json";

/**
 * File-based implementation of UpdateCheckCacheRepository.
 * Stores cache data in ~/.swamp/last-update-check.json.
 */
export class UpdateCheckCacheFileRepository
  implements UpdateCheckCacheRepository {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(getSwampDataDir(), CACHE_FILE_NAME);
  }

  async read(): Promise<UpdateCheckCacheData | null> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      const data = JSON.parse(content) as UpdateCheckCacheData;

      // Basic shape validation
      if (
        typeof data.latestVersion === "string" &&
        typeof data.checkedAt === "string"
      ) {
        return data;
      }
      return null;
    } catch {
      return null;
    }
  }

  async write(data: UpdateCheckCacheData): Promise<void> {
    const dir = join(this.filePath, "..");
    await Deno.mkdir(dir, { recursive: true });
    await atomicWriteTextFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
