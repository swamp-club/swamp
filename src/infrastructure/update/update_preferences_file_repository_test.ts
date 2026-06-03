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
import { UpdatePreferencesFileRepository } from "./update_preferences_file_repository.ts";
import { DEFAULT_UPDATE_PREFERENCES } from "../../domain/update/update_preferences.ts";

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

Deno.test("UpdatePreferencesFileRepository: returns defaults when file missing", async () => {
  await withTempDir(async (dir) => {
    const repo = new UpdatePreferencesFileRepository(
      join(dir, "nonexistent", "update.yaml"),
    );
    const prefs = await repo.read();
    assertEquals(prefs, DEFAULT_UPDATE_PREFERENCES);
  });
});

Deno.test("UpdatePreferencesFileRepository: round-trips preferences", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "update.yaml");
    const repo = new UpdatePreferencesFileRepository(filePath);

    const prefs = {
      enabled: true,
      cadence: "weekly" as const,
    };
    await repo.write(prefs);

    const result = await repo.read();
    assertEquals(result.enabled, true);
    assertEquals(result.cadence, "weekly");
  });
});

Deno.test("UpdatePreferencesFileRepository: handles corrupt file gracefully", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "update.yaml");
    await Deno.writeTextFile(filePath, "not: [valid: yaml: {{{");

    const repo = new UpdatePreferencesFileRepository(filePath);
    const prefs = await repo.read();
    assertEquals(prefs, DEFAULT_UPDATE_PREFERENCES);
  });
});

Deno.test("UpdatePreferencesFileRepository: fills missing fields with defaults", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "update.yaml");
    await Deno.writeTextFile(filePath, "enabled: true\n");

    const repo = new UpdatePreferencesFileRepository(filePath);
    const prefs = await repo.read();
    assertEquals(prefs.enabled, true);
    assertEquals(prefs.cadence, "daily");
  });
});

Deno.test("UpdatePreferencesFileRepository: rejects invalid cadence", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "update.yaml");
    await Deno.writeTextFile(filePath, "enabled: true\ncadence: hourly\n");

    const repo = new UpdatePreferencesFileRepository(filePath);
    const prefs = await repo.read();
    assertEquals(prefs.cadence, "daily");
  });
});

Deno.test("UpdatePreferencesFileRepository: write succeeds when notifiedVersion is undefined", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "update.yaml");
    const repo = new UpdatePreferencesFileRepository(filePath);

    const prefs = await repo.read();
    await repo.write({ ...prefs, enabled: true });

    const result = await repo.read();
    assertEquals(result.enabled, true);
    assertEquals(result.cadence, "daily");
    assertEquals(result.notifiedVersion, undefined);
  });
});

Deno.test("UpdatePreferencesFileRepository: write preserves notifiedVersion when present", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "update.yaml");
    const repo = new UpdatePreferencesFileRepository(filePath);

    await repo.write({
      enabled: true,
      cadence: "weekly",
      notifiedVersion: "1.2.3",
    });

    const result = await repo.read();
    assertEquals(result.enabled, true);
    assertEquals(result.cadence, "weekly");
    assertEquals(result.notifiedVersion, "1.2.3");
  });
});

Deno.test("UpdatePreferencesFileRepository: creates parent directories", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "nested", "dirs", "update.yaml");
    const repo = new UpdatePreferencesFileRepository(filePath);

    await repo.write({ enabled: true, cadence: "daily" });
    const prefs = await repo.read();
    assertEquals(prefs.enabled, true);
  });
});
