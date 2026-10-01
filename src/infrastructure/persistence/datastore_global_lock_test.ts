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
import type { FilesystemDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { datastoreGlobalLock } from "./datastore_global_lock.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-global-lock-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("datastoreGlobalLock: takes the datastore's .datastore.lock on acquire and frees it on release", async () => {
  await withTempDir(async (dir) => {
    const config: FilesystemDatastoreConfig = { type: "filesystem", path: dir };
    const lock = datastoreGlobalLock(config);
    const lockFile = join(dir, ".datastore.lock");

    await lock.acquire();
    assertEquals(await exists(lockFile), true);
    await lock.release();
    assertEquals(await exists(lockFile), false);

    // Each acquire takes a fresh lock; a release with none held is a no-op.
    await lock.acquire();
    await lock.release();
    await lock.release();
    assertEquals(await exists(lockFile), false);
  });
});
