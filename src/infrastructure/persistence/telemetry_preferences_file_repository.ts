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
import { parse, stringify } from "@std/yaml";
import { getSwampConfigDir } from "./paths.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";

const PREFERENCES_FILE_NAME = "telemetry.yaml";

/**
 * User-level telemetry preferences, persisted at
 * `<config>/telemetry.yaml` (XDG-aware).
 *
 * This is the persistent opt-out for the repo-less telemetry path: outside a
 * swamp repo there is no marker to carry `telemetryDisabled`, so this file is
 * the durable equivalent. `disabled` mirrors the marker's `telemetryDisabled`
 * polarity (default `false` = telemetry enabled).
 */
export interface TelemetryPreferences {
  readonly disabled: boolean;
}

/** Default preferences when no file exists: telemetry enabled. */
export const DEFAULT_TELEMETRY_PREFERENCES: TelemetryPreferences = {
  disabled: false,
};

/**
 * Reads and writes the user-level telemetry preferences file. Never throws on
 * read — a missing or malformed file yields the default (enabled), matching the
 * best-effort discipline of the rest of the telemetry pipeline.
 */
export class TelemetryPreferencesFileRepository {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ??
      join(getSwampConfigDir(), PREFERENCES_FILE_NAME);
  }

  async read(): Promise<TelemetryPreferences> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      const data = parse(content) as Record<string, unknown> | null;

      if (!data || typeof data !== "object") {
        return { ...DEFAULT_TELEMETRY_PREFERENCES };
      }

      return {
        disabled: typeof data.disabled === "boolean"
          ? data.disabled
          : DEFAULT_TELEMETRY_PREFERENCES.disabled,
      };
    } catch {
      return { ...DEFAULT_TELEMETRY_PREFERENCES };
    }
  }

  async write(preferences: TelemetryPreferences): Promise<void> {
    const dir = dirname(this.filePath);
    await Deno.mkdir(dir, { recursive: true });
    await atomicWriteTextFile(this.filePath, stringify({ ...preferences }));
  }
}
