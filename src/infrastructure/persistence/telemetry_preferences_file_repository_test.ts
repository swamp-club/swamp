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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_TELEMETRY_PREFERENCES,
  TelemetryPreferencesFileRepository,
} from "./telemetry_preferences_file_repository.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("TelemetryPreferencesFileRepository: enabled by default when file missing", async () => {
  await withTempDir(async (dir) => {
    const repo = new TelemetryPreferencesFileRepository(
      join(dir, "nonexistent", "telemetry.yaml"),
    );
    const prefs = await repo.read();
    assertEquals(prefs, DEFAULT_TELEMETRY_PREFERENCES);
    assertEquals(prefs.disabled, false);
  });
});

Deno.test("TelemetryPreferencesFileRepository: honors disabled: true", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "telemetry.yaml");
    const repo = new TelemetryPreferencesFileRepository(filePath);

    await repo.write({ disabled: true });

    const result = await repo.read();
    assertEquals(result.disabled, true);
  });
});

Deno.test("TelemetryPreferencesFileRepository: round-trips disabled: false", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "telemetry.yaml");
    const repo = new TelemetryPreferencesFileRepository(filePath);

    await repo.write({ disabled: false });

    const result = await repo.read();
    assertEquals(result.disabled, false);
  });
});

Deno.test("TelemetryPreferencesFileRepository: falls back to enabled on corrupt file", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "telemetry.yaml");
    await Deno.writeTextFile(filePath, "not: [valid: yaml: {{{");

    const repo = new TelemetryPreferencesFileRepository(filePath);
    const prefs = await repo.read();
    assertEquals(prefs, DEFAULT_TELEMETRY_PREFERENCES);
  });
});

Deno.test("TelemetryPreferencesFileRepository: ignores non-boolean disabled field", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "telemetry.yaml");
    await Deno.writeTextFile(filePath, "disabled: yes-please\n");

    const repo = new TelemetryPreferencesFileRepository(filePath);
    const prefs = await repo.read();
    assertEquals(prefs.disabled, false);
  });
});
