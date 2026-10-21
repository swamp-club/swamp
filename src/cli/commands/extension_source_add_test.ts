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
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { VERSION } from "./version.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-source-add-" });
  try {
    const homeDir = join(dir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * Adds an unexpanded glob source (allowed before its directories exist) with
 * `--only only`, and returns the `.swamp-sources.yaml` it writes. `~` resolves
 * to a home directory under `dir`, so the glob never walks the real home,
 * where another process can remove a directory mid-walk (swamp-club#3694).
 */
async function addWithOnly(dir: string, only: string): Promise<string> {
  const { extensionSourceAddCommand } = await import(
    "./extension_source_add.ts"
  );
  const home = join(dir, "test-home");
  await Deno.mkdir(home, { recursive: true });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await withMockedEnv({ HOME: home, USERPROFILE: home }, () =>
      new Command()
        .globalOption("--json", "JSON output")
        .command("add", extensionSourceAddCommand)
        .parse([
          "add",
          "~/swamp-source-add-test-*",
          "--only",
          only,
          "--repo-dir",
          dir,
          "--json",
        ]));
  } finally {
    console.log = originalLog;
  }
  return await Deno.readTextFile(join(dir, ".swamp-sources.yaml"));
}

Deno.test("extension source add --only: behaviors is persisted as models (swamp-club#3410)", async () => {
  for (
    const [behaviorForm, modelForm] of [
      ["behaviors", "models"],
      ["behaviors,vaults", "models,vaults"],
      ["behaviors,models", "models"],
      ["vaults, behaviors", "vaults,models"],
    ]
  ) {
    let expected = "";
    await withRepo(async (dir) => {
      expected = await addWithOnly(dir, modelForm);
    });
    await withRepo(async (dir) => {
      assertEquals(
        await addWithOnly(dir, behaviorForm),
        expected,
        behaviorForm,
      );
    });
  }
});

Deno.test("extension source add --only: a model-spelled list is persisted as typed", async () => {
  await withRepo(async (dir) => {
    const written = await addWithOnly(dir, "models,models,vaults");
    assertStringIncludes(written, "- models\n      - models\n      - vaults");
  });
});

Deno.test("extension source add --only: behaviours is not a synonym and fails naming the value", async () => {
  await withRepo(async (dir) => {
    await assertRejects(
      () => addWithOnly(dir, "behaviours"),
      Error,
      "Unknown extension kind 'behaviours'",
    );
  });
});
