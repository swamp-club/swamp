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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { TelemetryPreferencesFileRepository } from "../../infrastructure/persistence/telemetry_preferences_file_repository.ts";
import { WorkspacePreferencesFileRepository } from "../../infrastructure/persistence/workspace_preferences_file_repository.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { configCommand } from "./config.ts";
import "../../domain/models/models.ts";

await initializeLogging({});

async function withTempConfigDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await withMockedEnv({ SWAMP_CONFIG_DIR: dir }, () => fn(dir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("config get: rejects unknown key", async () => {
  await withTempConfigDir(async () => {
    const error = await assertRejects(() =>
      configCommand.parse(["get", "unknown.key"])
    );
    assertStringIncludes(
      (error as Error).message,
      "Unknown config key: unknown.key",
    );
    assertStringIncludes((error as Error).message, "update.auto");
  });
});

Deno.test("config set: rejects invalid cadence", async () => {
  await withTempConfigDir(async (dir) => {
    const error = await assertRejects(() =>
      configCommand.parse(["set", "update.cadence", "monthly"])
    );
    assertStringIncludes(
      (error as Error).message,
      "Invalid value for update.cadence",
    );
    // Nothing is written for a rejected value.
    assertEquals(await Array.fromAsync(Deno.readDir(dir)), []);
  });
});

Deno.test("config set: rejects unknown key", async () => {
  await withTempConfigDir(async () => {
    const error = await assertRejects(() =>
      configCommand.parse(["set", "bogus.key", "value"])
    );
    assertStringIncludes(
      (error as Error).message,
      "Unknown config key: bogus.key",
    );
  });
});

Deno.test("config set telemetry.collection: writes the user-level opt-out", async () => {
  await withTempConfigDir(async (dir) => {
    await configCommand.parse(["set", "telemetry.collection", "disabled"]);
    const repo = new TelemetryPreferencesFileRepository(
      join(dir, "telemetry.yaml"),
    );
    assertEquals((await repo.read()).disabled, true);

    await configCommand.parse(["set", "telemetry.collection", "enabled"]);
    assertEquals((await repo.read()).disabled, false);
  });
});

Deno.test("config set telemetry.collection: keeps a hand-written opt-out readable", async () => {
  await withTempConfigDir(async (dir) => {
    // Files written by hand before the config key existed use this shape.
    await Deno.writeTextFile(join(dir, "telemetry.yaml"), "disabled: true\n");
    const repo = new TelemetryPreferencesFileRepository(
      join(dir, "telemetry.yaml"),
    );
    assertEquals((await repo.read()).disabled, true);

    // get and list read the same file without throwing.
    await configCommand.parse(["get", "telemetry.collection"]);
    await configCommand.parse(["list"]);
  });
});

Deno.test("config set telemetry.collection: rejects values other than enabled|disabled", async () => {
  await withTempConfigDir(async (dir) => {
    const error = await assertRejects(() =>
      configCommand.parse(["set", "telemetry.collection", "off"])
    );
    assertStringIncludes(
      (error as Error).message,
      "Invalid value for telemetry.collection",
    );
    // Nothing is written for a rejected value.
    const exists = await Deno.stat(join(dir, "telemetry.yaml")).then(
      () => true,
      () => false,
    );
    assertEquals(exists, false);
  });
});

Deno.test("config set workspaces.dir: stores the folder's real path, and default clears it", async () => {
  await withTempConfigDir(async (dir) => {
    const folder = join(dir, "dev");
    await Deno.mkdir(folder);
    const repo = new WorkspacePreferencesFileRepository(
      join(dir, "workspaces.yaml"),
    );
    await configCommand.parse(["set", "workspaces.dir", folder]);
    assertEquals((await repo.read()).dir, await Deno.realPath(folder));
    // Only its own file: the update scheduler is never touched.
    assertEquals(
      (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort(),
      ["dev", "workspaces.yaml"],
    );
    await configCommand.parse(["get", "workspaces.dir"]);
    await configCommand.parse(["list"]);

    await configCommand.parse(["set", "workspaces.dir", "default"]);
    assertEquals(await repo.read(), {});
  });
});

Deno.test("config set workspaces.dir: expands ~ from the home folder", async () => {
  await withTempConfigDir(async (dir) => {
    await Deno.mkdir(join(dir, "projects"));
    await withMockedEnv({ SWAMP_CONFIG_DIR: dir, HOME: dir }, async () => {
      await configCommand.parse(["set", "workspaces.dir", "~/projects"]);
    });
    const repo = new WorkspacePreferencesFileRepository(
      join(dir, "workspaces.yaml"),
    );
    assertEquals(
      (await repo.read()).dir,
      await Deno.realPath(join(dir, "projects")),
    );
  });
});

Deno.test("config set workspaces.dir: rejects a folder that doesn't exist, writing nothing", async () => {
  await withTempConfigDir(async (dir) => {
    const error = await assertRejects(() =>
      configCommand.parse(["set", "workspaces.dir", join(dir, "nope")])
    );
    assertStringIncludes((error as Error).message, "There's no folder at");
    assertEquals(await Array.fromAsync(Deno.readDir(dir)), []);
  });
});
