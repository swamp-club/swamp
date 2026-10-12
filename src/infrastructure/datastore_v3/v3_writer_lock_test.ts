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
import { hostname } from "node:os";
import { FileLock } from "../persistence/file_lock.ts";
import {
  acquireV3WriterLock,
  holdsV3WriterLock,
  V3_WRITER_LOCK_KEY,
  V3WriterBusyError,
  v3WriterLockHandle,
} from "./v3_writer_lock.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-writer-lock-" });
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

Deno.test("acquireV3WriterLock: one hold per process, released by the last caller", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, V3_WRITER_LOCK_KEY);
    const first = await acquireV3WriterLock(dir);
    const second = await acquireV3WriterLock(dir);
    assert(holdsV3WriterLock(dir));
    await Deno.stat(lockPath);

    await first();
    assert(holdsV3WriterLock(dir), "the second caller still holds it");
    await Deno.stat(lockPath);

    await second();
    assertEquals(holdsV3WriterLock(dir), false);
    await assertRejects(() => Deno.stat(lockPath), Deno.errors.NotFound);
    // A release is idempotent.
    await second();
  });
});

Deno.test("acquireV3WriterLock: another process's hold refuses with its holder named", async () => {
  await withTempDir(async (dir) => {
    const other = new FileLock(dir, { lockKey: V3_WRITER_LOCK_KEY });
    await other.acquire();
    try {
      const error = await assertRejects(
        () => acquireV3WriterLock(dir, { maxWaitMs: 100 }),
        V3WriterBusyError,
      );
      assertEquals(error.code, "datastore_v3_writer_busy");
      assert(error.message.includes(`pid ${Deno.pid}`));
      assertEquals(holdsV3WriterLock(dir), false);
    } finally {
      await other.release();
    }
    // Once the other process lets go, this one takes it.
    const release = await acquireV3WriterLock(dir, { maxWaitMs: 1000 });
    await release();
  });
});

Deno.test("v3WriterLockHandle: inspects the writer lock without taking it", async () => {
  await withTempDir(async (dir) => {
    const handle = v3WriterLockHandle(dir);
    assertEquals(await handle.inspect(), null);
    const release = await acquireV3WriterLock(dir);
    try {
      assertEquals((await handle.inspect())?.pid, Deno.pid);
    } finally {
      await release();
    }
  });
});

/** A writer-lock file as another process left it. */
async function plantHolder(dir: string, hostname: string): Promise<void> {
  await Deno.mkdir(join(dir, "_control"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, V3_WRITER_LOCK_KEY),
    JSON.stringify({
      holder: "other",
      hostname,
      // No process here has this pid.
      pid: 2147483647,
      acquiredAt: new Date().toISOString(),
      ttlMs: 60_000,
      nonce: crypto.randomUUID(),
    }),
  );
}

Deno.test("acquireV3WriterLock: another host's holder is alive until its TTL, whatever its pid here", async () => {
  await withTempDir(async (dir) => {
    await plantHolder(dir, `other-host-${crypto.randomUUID()}`);
    await assertRejects(
      () => acquireV3WriterLock(dir, { maxWaitMs: 100 }),
      V3WriterBusyError,
    );
  });
});

Deno.test("acquireV3WriterLock: a holder on this host whose process is gone is cleared", async () => {
  await withTempDir(async (dir) => {
    await plantHolder(dir, hostname());
    const release = await acquireV3WriterLock(dir, { maxWaitMs: 1_000 });
    await release();
  });
});
