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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { UserError } from "../../domain/errors.ts";
import { createDatastoreLock } from "../../infrastructure/persistence/datastore_global_lock.ts";
import { createModelLock, resolveDatastoreForRepo } from "../repo_context.ts";
import { VERSION } from "./version.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-datastore-lock-" });
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

async function release(dir: string, args: string[]): Promise<void> {
  const { datastoreLockCommand } = await import("./datastore_lock.ts");
  const originalLog = console.log;
  console.log = () => {};
  try {
    await new Command()
      .globalOption("--json", "JSON output")
      .command("lock", datastoreLockCommand)
      .parse([
        "lock",
        "release",
        "--force",
        "--repo-dir",
        dir,
        ...args,
        "--json",
      ]);
  } finally {
    console.log = originalLog;
  }
}

// --behavior and its alias --model fill one option (swamp-club#3410). A read
// of the old key would find nothing and release the global lock instead.
for (const flag of ["--behavior", "--model"]) {
  Deno.test({
    name:
      `datastore lock release: ${flag} releases that behavior's lock, not the global one`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withRepo(async (dir) => {
        const { datastoreConfig } = await resolveDatastoreForRepo(dir);
        const modelLock = await createModelLock(
          datastoreConfig,
          "aws-ec2",
          "my-server",
        );
        const globalLock = await createDatastoreLock(datastoreConfig);
        await modelLock.acquire();
        await globalLock.acquire();
        try {
          await release(dir, [flag, "aws-ec2/my-server"]);
          assertEquals(await modelLock.inspect(), null, "behavior lock");
          assert(await globalLock.inspect() !== null, "global lock kept");
        } finally {
          await globalLock.release();
          await modelLock.release().catch(() => {});
        }
      });
    },
  });

  Deno.test({
    name: `datastore lock release: ${flag} value is validated as type/id`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withRepo(async (dir) => {
        await assertRejects(
          () => release(dir, [flag, "no-slash"]),
          UserError,
          'Invalid --model format: "no-slash"',
        );
      });
    },
  });
}
