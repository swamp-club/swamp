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
import { dirname, isAbsolute, join } from "@std/path";
import { parse, stringify } from "@std/yaml";
import { getSwampConfigDir } from "./paths.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";

const PREFERENCES_FILE_NAME = "workspaces.yaml";

/**
 * User-level workspace preferences, persisted at `<config>/workspaces.yaml`.
 * Set with `swamp config set workspaces.dir <folder>`.
 */
export interface WorkspacePreferences {
  /**
   * The absolute folder new workspaces are created in; unset means
   * `<data dir>/workspaces`.
   */
  readonly dir?: string;
}

/**
 * Reads and writes the workspace preferences file. Never throws on read: a
 * missing or malformed file, or a `dir` that isn't an absolute path, yields
 * no preference.
 */
export class WorkspacePreferencesFileRepository {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ??
      join(getSwampConfigDir(), PREFERENCES_FILE_NAME);
  }

  async read(): Promise<WorkspacePreferences> {
    try {
      const data = parse(await Deno.readTextFile(this.filePath)) as
        | Record<string, unknown>
        | null;
      if (
        data && typeof data === "object" && typeof data.dir === "string" &&
        isAbsolute(data.dir)
      ) {
        return { dir: data.dir };
      }
      return {};
    } catch {
      return {};
    }
  }

  async write(preferences: WorkspacePreferences): Promise<void> {
    await Deno.mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteTextFile(
      this.filePath,
      stringify(preferences.dir !== undefined ? { dir: preferences.dir } : {}),
    );
  }
}
