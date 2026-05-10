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

import { dirname, join } from "@std/path";
import { parse, stringify } from "@std/yaml";
import {
  DEFAULT_UPDATE_PREFERENCES,
  isValidCadence,
  type UpdatePreferences,
  type UpdatePreferencesRepository,
} from "../../domain/update/update_preferences.ts";
import { getSwampConfigDir } from "../persistence/paths.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

const PREFERENCES_FILE_NAME = "update.yaml";

export class UpdatePreferencesFileRepository
  implements UpdatePreferencesRepository {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ??
      join(getSwampConfigDir(), PREFERENCES_FILE_NAME);
  }

  async read(): Promise<UpdatePreferences> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      const data = parse(content) as Record<string, unknown>;

      if (!data || typeof data !== "object") {
        return { ...DEFAULT_UPDATE_PREFERENCES };
      }

      return {
        enabled: typeof data.enabled === "boolean"
          ? data.enabled
          : DEFAULT_UPDATE_PREFERENCES.enabled,
        cadence:
          typeof data.cadence === "string" && isValidCadence(data.cadence)
            ? data.cadence
            : DEFAULT_UPDATE_PREFERENCES.cadence,
        notifiedVersion: typeof data.notifiedVersion === "string"
          ? data.notifiedVersion
          : undefined,
        lastPermissionWarning: typeof data.lastPermissionWarning === "string"
          ? data.lastPermissionWarning
          : undefined,
      };
    } catch {
      return { ...DEFAULT_UPDATE_PREFERENCES };
    }
  }

  async write(preferences: UpdatePreferences): Promise<void> {
    const dir = dirname(this.filePath);
    await Deno.mkdir(dir, { recursive: true });
    const defined = Object.fromEntries(
      Object.entries(preferences).filter(([, v]) => v !== undefined),
    );
    await atomicWriteTextFile(this.filePath, stringify(defined));
  }
}
