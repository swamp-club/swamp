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
import { atomicWriteTextFile } from "./atomic_write.ts";
import { getSwampConfigDir } from "./paths.ts";

const BUILTIN_TOOL_SKILL_DIRS_FILE = "builtin-tool-skill-dirs.json";

export class BuiltInToolSkillDirsRepository {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ??
      join(getSwampConfigDir(), BUILTIN_TOOL_SKILL_DIRS_FILE);
  }

  async exists(): Promise<boolean> {
    try {
      await Deno.stat(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<string[]> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is string =>
        typeof entry === "string"
      );
    } catch {
      return [];
    }
  }

  async write(dirs: string[]): Promise<void> {
    const unique = [...new Set(dirs)];
    await Deno.mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteTextFile(
      this.filePath,
      JSON.stringify(unique, null, 2) + "\n",
    );
  }

  async addDirs(dirs: string[]): Promise<void> {
    const existing = await this.read();
    const toAdd = dirs.filter((d) => !existing.includes(d));
    if (toAdd.length === 0) return;
    await this.write([...existing, ...toAdd]);
  }
}
