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

// `swamp datastore lock release` and `status` against a real FileLock whose
// lock file is caught mid-write: it exists but is empty. Wires FileLock
// through the deps factories the CLI uses (swamp-club#3152).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FileLock } from "../src/infrastructure/persistence/file_lock.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createDatastoreLockReleaseDeps,
  createDatastoreLockStatusDeps,
  datastoreLockRelease,
  datastoreLockStatus,
} from "../src/libswamp/datastores/lock.ts";
import { collect } from "../src/libswamp/testing.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-mid-write-" });
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

Deno.test("datastore lock release: a lock file caught mid-write is left in place with a retry reason", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, ".datastore.lock");
    await Deno.writeFile(lockPath, new Uint8Array());

    const events = await collect(
      datastoreLockRelease(
        createLibSwampContext(),
        createDatastoreLockReleaseDeps(new FileLock(dir)),
      ),
    );

    assertEquals(events, [{
      kind: "completed",
      data: {
        released: false,
        reason: "lock is being written by its holder — retry shortly",
      },
    }]);
    assertEquals(await exists(lockPath), true);
  });
});

Deno.test("datastore lock status: a lock file caught mid-write reads as held by an unknown holder", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeFile(join(dir, ".datastore.lock"), new Uint8Array());

    const events = await collect(
      datastoreLockStatus(
        createLibSwampContext(),
        createDatastoreLockStatusDeps(new FileLock(dir), {
          type: "filesystem",
          path: dir,
        }),
        { datastoreType: "filesystem", isFilesystemDatastore: true },
      ),
    );

    assertEquals(events.length, 1);
    const [event] = events;
    if (event.kind !== "completed") throw new Error("expected completed");
    assertEquals(event.data.held, true);
    assertEquals(event.data.info?.holderUnknown, true);
    assertEquals(event.data.info?.nonce, undefined);
  });
});

Deno.test("datastore lock release: an old-format lock file with no nonce is still released", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, ".datastore.lock");
    const oldFormat = {
      holder: "someone@somehost",
      hostname: "somehost",
      pid: 12345,
      acquiredAt: new Date().toISOString(),
      ttlMs: 30000,
    };
    await Deno.writeTextFile(lockPath, JSON.stringify(oldFormat));

    const events = await collect(
      datastoreLockRelease(
        createLibSwampContext(),
        createDatastoreLockReleaseDeps(new FileLock(dir)),
      ),
    );

    assertEquals(events, [{
      kind: "completed",
      data: { released: true, previousHolder: oldFormat },
    }]);
    assertEquals(await exists(lockPath), false);
  });
});
