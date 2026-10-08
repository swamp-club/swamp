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
import { UserError } from "../../domain/errors.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { vaultCreateCommand } from "./vault_create.ts";
import { vaultListKeysCommand } from "./vault_list_keys.ts";
import { VERSION } from "./version.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-list-keys-" });
  try {
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

async function initRepo(dir: string): Promise<void> {
  const homeDir = join(dir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(dir), { tools: [] });
}

function listKeysWithoutName(dir: string): Promise<unknown> {
  return new Command()
    .throwErrors()
    .globalOption("--json", "JSON output")
    .command("list-keys", vaultListKeysCommand)
    .parse(["list-keys", "--repo-dir", dir, "--json"]);
}

Deno.test("vaultListKeysCommand: vault_name is an optional argument", () => {
  assertEquals(
    vaultListKeysCommand.getArguments().map((a) => [a.name, a.optional]),
    [["vault_name", true]],
  );
});

Deno.test("vaultListKeysCommand: no vault name fails with the available vaults (swamp-club#2871)", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);

    const originalLog = console.log;
    console.log = () => {};
    try {
      await new Command()
        .globalOption("--json", "JSON output")
        .command("create", vaultCreateCommand)
        .parse([
          "create",
          "local_encryption",
          "dev-secrets",
          "--repo-dir",
          dir,
          "--json",
        ]);
    } finally {
      console.log = originalLog;
    }

    const error = await assertRejects(
      () => listKeysWithoutName(dir),
      UserError,
    );
    assertEquals(
      error.message,
      "Missing argument(s): vault_name. Available vaults: dev-secrets",
    );
  });
});

Deno.test("vaultListKeysCommand: no vault name and no vaults says none are configured (swamp-club#2871)", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);

    const error = await assertRejects(
      () => listKeysWithoutName(dir),
      UserError,
    );
    assertStringIncludes(
      error.message,
      "Missing argument(s): vault_name. No vaults are configured.",
    );
  });
});
