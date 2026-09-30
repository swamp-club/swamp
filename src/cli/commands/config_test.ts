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
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { configCommand } from "./config.ts";
import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("config get: rejects unknown key", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "main.ts",
      "config",
      "get",
      "unknown.key",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stderr = new TextDecoder().decode(result.stderr);
  assertStringIncludes(stderr, "Unknown config key: unknown.key");
  assertStringIncludes(stderr, "update.auto");
});

Deno.test("config set: rejects invalid cadence", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "main.ts",
      "config",
      "set",
      "update.cadence",
      "monthly",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stderr = new TextDecoder().decode(result.stderr);
  assertStringIncludes(stderr, "Invalid value for update.cadence");
});

Deno.test("config set: rejects unknown key", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "main.ts",
      "config",
      "set",
      "bogus.key",
      "value",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stderr = new TextDecoder().decode(result.stderr);
  assertStringIncludes(stderr, "Unknown config key: bogus.key");
});

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
