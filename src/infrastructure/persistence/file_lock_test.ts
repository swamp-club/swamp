// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertRejects } from "@std/assert";
import { FileLock } from "./file_lock.ts";
import type { LockInfo } from "../../domain/datastore/distributed_lock.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("FileLock - acquire and release", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });
    await lock.acquire();

    // Lock file should exist
    const info = await lock.inspect();
    assertEquals(info !== null, true);
    assertEquals(info!.pid, Deno.pid);
    assertEquals(info!.ttlMs, 5000);

    await lock.release();

    // Lock file should be gone
    const afterRelease = await lock.inspect();
    assertEquals(afterRelease, null);
  });
});

Deno.test("FileLock - release is idempotent", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });
    await lock.acquire();
    await lock.release();
    await lock.release(); // Should not throw
  });
});

Deno.test("FileLock - withLock executes callback and releases", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });
    const result = await lock.withLock(async () => {
      // Lock should be held
      const info = await lock.inspect();
      assertEquals(info !== null, true);
      return 42;
    });

    assertEquals(result, 42);

    // Lock should be released
    const afterRelease = await lock.inspect();
    assertEquals(afterRelease, null);
  });
});

Deno.test("FileLock - withLock releases on error", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });
    try {
      await lock.withLock(() => {
        return Promise.reject(new Error("test error"));
      });
    } catch {
      // Expected
    }

    // Lock should be released after error
    const afterError = await lock.inspect();
    assertEquals(afterError, null);
  });
});

Deno.test("FileLock - second acquire blocks and times out", async () => {
  await withTempDir(async (dir) => {
    const lock1 = new FileLock(dir, {
      ttlMs: 60_000, // Long TTL so it won't be considered stale
    });
    const lock2 = new FileLock(dir, {
      ttlMs: 60_000,
      retryIntervalMs: 100,
      maxWaitMs: 500,
    });

    await lock1.acquire();

    await assertRejects(
      () => lock2.acquire(),
      LockTimeoutError,
    );

    await lock1.release();
  });
});

Deno.test("FileLock - stale lock is force-acquired", async () => {
  await withTempDir(async (dir) => {
    // Simulate a stale lock by writing a lockfile with expired TTL
    const staleLockInfo: LockInfo = {
      holder: "stale@host",
      hostname: "host",
      pid: 99999,
      acquiredAt: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
      ttlMs: 5000, // 5 second TTL — long expired
    };
    const lockPath = `${dir}/.datastore.lock`;
    await Deno.writeTextFile(lockPath, JSON.stringify(staleLockInfo, null, 2));

    // New lock should detect staleness and force-acquire
    const lock = new FileLock(dir, { ttlMs: 5000 });
    await lock.acquire();

    const info = await lock.inspect();
    assertEquals(info !== null, true);
    assertEquals(info!.pid, Deno.pid);

    await lock.release();
  });
});

Deno.test("FileLock - inspect returns null when no lock exists", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });
    const info = await lock.inspect();
    assertEquals(info, null);
  });
});

Deno.test("FileLock - forceRelease deletes lock when nonce matches", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });
    await lock.acquire();

    const info = await lock.inspect();
    assertEquals(info !== null, true);

    // forceRelease with matching nonce should succeed
    const released = await lock.forceRelease(info!.nonce!);
    assertEquals(released, true);

    // Lock should be gone
    const afterRelease = await lock.inspect();
    assertEquals(afterRelease, null);

    // Clean up the lock's internal state (heartbeat)
    await lock.release();
  });
});

Deno.test("FileLock - forceRelease returns false when nonce does not match", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });
    await lock.acquire();

    // forceRelease with wrong nonce should fail
    const released = await lock.forceRelease("wrong-nonce");
    assertEquals(released, false);

    // Lock should still be held
    const info = await lock.inspect();
    assertEquals(info !== null, true);

    await lock.release();
  });
});

Deno.test("FileLock - forceRelease returns false when no lock exists", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });

    const released = await lock.forceRelease("some-nonce");
    assertEquals(released, false);
  });
});

Deno.test("FileLock - stale lock from dead process is immediately acquired", async () => {
  await withTempDir(async (dir) => {
    // Simulate a lock held by a non-existent process with a fresh timestamp
    // (i.e., TTL has NOT expired, but the process is dead)
    const staleLockInfo: LockInfo = {
      holder: "dead@host",
      hostname: "host",
      pid: 2147483647, // Very high PID — extremely unlikely to exist
      acquiredAt: new Date().toISOString(), // Fresh timestamp — TTL not expired
      ttlMs: 60_000, // Long TTL
    };
    const lockPath = `${dir}/.datastore.lock`;
    await Deno.writeTextFile(
      lockPath,
      JSON.stringify(staleLockInfo, null, 2),
    );

    // New lock should detect the dead PID and acquire immediately
    const lock = new FileLock(dir, { ttlMs: 5000, maxWaitMs: 2000 });
    await lock.acquire();

    const info = await lock.inspect();
    assertEquals(info !== null, true);
    assertEquals(info!.pid, Deno.pid);

    await lock.release();
  });
});

Deno.test("FileLock - lock held by live process is not stolen via PID check", async () => {
  await withTempDir(async (dir) => {
    // Simulate a lock held by the current process (which is definitely alive)
    // with a fresh timestamp — should NOT be considered stale
    const lockInfo: LockInfo = {
      holder: "me@host",
      hostname: "host",
      pid: Deno.pid, // Current process — definitely alive
      acquiredAt: new Date().toISOString(),
      ttlMs: 60_000,
      nonce: "existing-nonce",
    };
    const lockPath = `${dir}/.datastore.lock`;
    await Deno.writeTextFile(lockPath, JSON.stringify(lockInfo, null, 2));

    // New lock should NOT be able to acquire — process is alive and TTL not expired
    const lock = new FileLock(dir, {
      ttlMs: 60_000,
      retryIntervalMs: 50,
      maxWaitMs: 300,
    });

    await assertRejects(
      () => lock.acquire(),
      LockTimeoutError,
    );
  });
});

Deno.test("FileLock - custom lock key", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, {
      lockKey: "custom.lock",
      ttlMs: 5000,
    });
    await lock.acquire();

    // Should use the custom filename
    const stat = await Deno.stat(`${dir}/custom.lock`);
    assertEquals(stat.isFile, true);

    await lock.release();
  });
});
