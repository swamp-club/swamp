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

import { join } from "@std/path";
import type {
  ExtensionUpdateCheckMap,
  ExtensionUpdateCheckRepository,
} from "../../domain/extensions/extension_update_check_cache.ts";

const CACHE_FILENAME = "extension-update-checks.json";

/**
 * File-based implementation of ExtensionUpdateCheckRepository.
 * Reads/writes .swamp/extension-update-checks.json.
 */
export class FileExtensionUpdateCheckRepository
  implements ExtensionUpdateCheckRepository {
  private readonly filePath: string;

  constructor(swampDir: string) {
    this.filePath = join(swampDir, CACHE_FILENAME);
  }

  async read(): Promise<ExtensionUpdateCheckMap> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      return JSON.parse(content) as ExtensionUpdateCheckMap;
    } catch {
      return {};
    }
  }

  async write(data: ExtensionUpdateCheckMap): Promise<void> {
    await Deno.writeTextFile(
      this.filePath,
      JSON.stringify(data, null, 2) + "\n",
    );
  }
}
