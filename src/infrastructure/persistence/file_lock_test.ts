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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { configure, type LogRecord } from "@logtape/logtape";
import { waitFor } from "@swamp-club/swamp-testing";
import { FileLock, nextBackoffSleep } from "./file_lock.ts";
import type { LockInfo } from "../../domain/datastore/distributed_lock.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { initializeLogging } from "../logging/logger.ts";

const capturedLogRecords: LogRecord[] = [];

await initializeLogging({});

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

Deno.test("FileLock.heldNonce: names the lock file's nonce only while held", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });
    assertEquals(lock.heldNonce, undefined);

    await lock.acquire();
    const info = await lock.inspect();
    assert(info?.nonce);
    assertEquals(lock.heldNonce, info.nonce);

    await lock.release();
    assertEquals(lock.heldNonce, undefined);
  });
});

Deno.test("FileLock.heldNonce: stays the same across heartbeat rewrites", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 300 });
    await lock.acquire();
    try {
      const first = await lock.inspect();
      assert(first);
      await waitFor(
        async () => (await lock.inspect())?.acquiredAt !== first.acquiredAt,
        "heartbeat rewrites the lock file",
      );
      const rewritten = await lock.inspect();
      assertEquals(rewritten?.nonce, first.nonce);
      assertEquals(lock.heldNonce, first.nonce);
    } finally {
      await lock.release();
    }
  });
});

Deno.test("FileLock.heldNonce: clears when the heartbeat finds another holder's nonce", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 300 });
    await lock.acquire();
    try {
      const info = await lock.inspect();
      assert(info);
      await Deno.writeTextFile(
        join(dir, ".datastore.lock"),
        JSON.stringify({ ...info, nonce: crypto.randomUUID() }),
      );
      await waitFor(
        () => lock.heldNonce === undefined,
        "heartbeat self-revokes the lock",
      );
    } finally {
      await lock.release();
    }
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

Deno.test("FileLock - timeout names the lock file with the platform separator", async () => {
  await withTempDir(async (dir) => {
    const holder = new FileLock(dir, { ttlMs: 60_000 });
    const waiter = new FileLock(dir, {
      ttlMs: 60_000,
      retryIntervalMs: 20,
      maxWaitMs: 100,
    });
    await holder.acquire();
    try {
      const error = await assertRejects(
        () => waiter.acquire(),
        LockTimeoutError,
      );
      assertEquals(error.lockKey, join(dir, ".datastore.lock"));
      assertStringIncludes(error.message, join(dir, ".datastore.lock"));
    } finally {
      await holder.release();
    }
  });
});

Deno.test("FileLock - timeout names a namespaced lock file with the platform separator", async () => {
  await withTempDir(async (dir) => {
    const options = { lockKey: ".datastore.lock", namespace: "prod" };
    const holder = new FileLock(dir, { ...options, ttlMs: 60_000 });
    const waiter = new FileLock(dir, {
      ...options,
      ttlMs: 60_000,
      retryIntervalMs: 20,
      maxWaitMs: 100,
    });
    await holder.acquire();
    try {
      const error = await assertRejects(
        () => waiter.acquire(),
        LockTimeoutError,
      );
      assertEquals(error.lockKey, join(dir, "prod", ".datastore.lock"));
    } finally {
      await holder.release();
    }
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

Deno.test("FileLock - namespace option scopes lock under namespace directory", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, {
      namespace: "infra",
      ttlMs: 5000,
    });

    // The namespace directory must NOT exist before acquisition.
    await assertRejects(() => Deno.stat(join(dir, "infra")));

    await lock.acquire();

    // Acquiring lazily creates the namespace directory and the lock file.
    const dirStat = await Deno.stat(join(dir, "infra"));
    assertEquals(dirStat.isDirectory, true);
    const fileStat = await Deno.stat(
      join(dir, "infra", ".datastore.lock"),
    );
    assertEquals(fileStat.isFile, true);

    await lock.release();
  });
});

Deno.test("FileLock - different namespaces acquire their locks concurrently", async () => {
  await withTempDir(async (dir) => {
    // Two repos sharing a datastore but in different namespaces must not
    // contend on the global lock.
    const infra = new FileLock(dir, {
      namespace: "infra",
      ttlMs: 5000,
    });
    const security = new FileLock(dir, {
      namespace: "security",
      ttlMs: 5000,
    });

    await infra.acquire();
    // Acquiring the other namespace's lock must not block on infra's lock.
    await security.acquire();

    assertEquals((await infra.inspect()) !== null, true);
    assertEquals((await security.inspect()) !== null, true);

    await infra.release();
    await security.release();
  });
});

Deno.test("FileLock - namespace with custom lockKey", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, {
      lockKey: ".datastore.lock",
      namespace: "prod",
      ttlMs: 5000,
    });
    await lock.acquire();

    const fileStat = await Deno.stat(
      join(dir, "prod", ".datastore.lock"),
    );
    assertEquals(fileStat.isFile, true);

    await lock.release();
  });
});

Deno.test("FileLock - backoff does not exceed maxWaitMs budget", async () => {
  await withTempDir(async (dir) => {
    const holder = new FileLock(dir, { ttlMs: 60_000 });
    await holder.acquire();

    const maxWaitMs = 800;
    const waiter = new FileLock(dir, {
      ttlMs: 60_000,
      retryIntervalMs: 100,
      maxWaitMs,
    });

    const start = Date.now();
    await assertRejects(() => waiter.acquire(), LockTimeoutError);
    const elapsed = Date.now() - start;

    // Should not overshoot maxWaitMs by more than one retry interval + jitter
    assert(
      elapsed < maxWaitMs + 500,
      `elapsed ${elapsed}ms should be close to maxWaitMs ${maxWaitMs}ms`,
    );

    await holder.release();
  });
});

Deno.test("FileLock - acquire succeeds after holder releases (contention path)", async () => {
  await withTempDir(async (dir) => {
    const holder = new FileLock(dir, { ttlMs: 60_000 });
    await holder.acquire();

    const waiter = new FileLock(dir, {
      ttlMs: 60_000,
      retryIntervalMs: 50,
      maxWaitMs: 5000,
    });

    // Release the holder after a short delay
    const releaseDelay = setTimeout(async () => {
      await holder.release();
    }, 200);

    const start = Date.now();
    await waiter.acquire();
    const elapsed = Date.now() - start;

    clearTimeout(releaseDelay);
    assert(elapsed >= 100, `should have waited for release, took ${elapsed}ms`);
    assert(
      elapsed < 3000,
      `should acquire quickly after release, took ${elapsed}ms`,
    );

    const info = await waiter.inspect();
    assertEquals(info!.pid, Deno.pid);

    await waiter.release();
  });
});

Deno.test("FileLock - maxBackoffMs defaults to 8s and honours an override", () => {
  assertEquals(new FileLock("/tmp").maxBackoffMs, 8_000);
  assertEquals(new FileLock("/tmp", { maxBackoffMs: 250 }).maxBackoffMs, 250);
});

Deno.test("nextBackoffSleep: doubles from the initial interval and holds at the cap", () => {
  // jitterSample 0.5 means no jitter, so the sequence is exact.
  const sleeps: number[] = [];
  let backoff = 25;
  for (let i = 0; i < 7; i++) {
    const { sleepMs, nextBackoffMs } = nextBackoffSleep(
      backoff,
      0.5,
      60_000,
      250,
    );
    sleeps.push(sleepMs);
    backoff = nextBackoffMs;
  }
  assertEquals(sleeps, [25, 50, 100, 200, 250, 250, 250]);
});

Deno.test("nextBackoffSleep: clamps the jittered sleep to the cap and the remaining budget", () => {
  // Maximum jitter (+25%) on a backoff already at the cap stays at the cap.
  assertEquals(nextBackoffSleep(250, 0.999, 60_000, 250).sleepMs, 250);
  // A sleep never overshoots what is left of maxWaitMs.
  assertEquals(nextBackoffSleep(200, 0.5, 30, 250).sleepMs, 30);
});

Deno.test("FileLock - waiter with a small maxBackoffMs acquires after the holder releases", async () => {
  await withTempDir(async (dir) => {
    capturedLogRecords.length = 0;
    await configure({
      sinks: {
        capture: (record: LogRecord) => {
          capturedLogRecords.push(record);
        },
      },
      loggers: [
        {
          category: ["datastore", "lock"],
          lowestLevel: "info",
          sinks: ["capture"],
        },
      ],
      reset: true,
    });
    const logged = (text: string) =>
      capturedLogRecords.some((r) =>
        r.message.map((p) => String(p)).join("").includes(text)
      );

    try {
      const holder = new FileLock(dir, { ttlMs: 60_000 });
      await holder.acquire();

      const waiter = new FileLock(dir, {
        ttlMs: 60_000,
        retryIntervalMs: 10,
        maxBackoffMs: 20,
        maxWaitMs: 10_000,
      });
      const acquired = waiter.acquire();
      // Release only once the waiter is in its backoff loop, so the
      // contention path is exercised rather than a first-try create.
      await waitFor(() => logged("Waiting for lock"), "waiter to back off");
      await holder.release();
      await acquired;

      assert(logged("Acquired lock"), "waiter should report its retries");
      assertEquals((await waiter.inspect())!.pid, Deno.pid);
      await waiter.release();
    } finally {
      await initializeLogging({ _reset: true });
    }
  });
});

Deno.test("FileLock - maxWaitMs override is respected", async () => {
  await withTempDir(async (dir) => {
    const holder = new FileLock(dir, { ttlMs: 60_000 });
    await holder.acquire();

    const shortTimeout = new FileLock(dir, {
      ttlMs: 60_000,
      retryIntervalMs: 50,
      maxWaitMs: 200,
    });
    const longTimeout = new FileLock(dir, {
      ttlMs: 60_000,
      retryIntervalMs: 50,
      maxWaitMs: 800,
    });

    const start1 = Date.now();
    await assertRejects(() => shortTimeout.acquire(), LockTimeoutError);
    const elapsed1 = Date.now() - start1;

    const start2 = Date.now();
    await assertRejects(() => longTimeout.acquire(), LockTimeoutError);
    const elapsed2 = Date.now() - start2;

    // Assert each run against its own configured floor (with slack for timer
    // granularity) — comparing the two measured durations to each other flips
    // under parallel scheduling jitter.
    assert(
      elapsed1 >= 150,
      `short timeout gave up before its 200ms budget (${elapsed1}ms)`,
    );
    assert(
      elapsed2 >= 600,
      `long timeout gave up before its 800ms budget (${elapsed2}ms)`,
    );

    await holder.release();
  });
});

/** Sets a file's mtime `ageMs` into the past. */
async function backdate(path: string, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs);
  await Deno.utime(path, past, past);
}

Deno.test("FileLock - fresh zero-byte lock file is treated as held, not removed", async () => {
  // A live holder's file is empty between create and write. Removing it
  // would let a second holder in (swamp-club#2571).
  await withTempDir(async (dir) => {
    const lockPath = `${dir}/.datastore.lock`;
    const file = await Deno.open(lockPath, { createNew: true, write: true });
    file.close();

    const lock = new FileLock(dir, {
      ttlMs: 60_000,
      maxWaitMs: 50,
      retryIntervalMs: 10,
    });
    await assertRejects(() => lock.acquire(), LockTimeoutError);
    assertEquals((await Deno.stat(lockPath)).size, 0);
  });
});

Deno.test("FileLock - zero-byte lock file is cleaned up and acquire succeeds", async () => {
  await withTempDir(async (dir) => {
    const lockPath = `${dir}/.datastore.lock`;
    // Simulate a crash between Deno.open({ createNew }) and file.write()
    const file = await Deno.open(lockPath, { createNew: true, write: true });
    file.close();
    const stat = await Deno.stat(lockPath);
    assertEquals(stat.size, 0);
    await backdate(lockPath, 10_000);

    const lock = new FileLock(dir, { ttlMs: 5000, maxWaitMs: 2000 });
    await lock.acquire();

    const info = await lock.inspect();
    assertEquals(info !== null, true);
    assertEquals(info!.pid, Deno.pid);

    await lock.release();
  });
});

Deno.test("FileLock - corrupt JSON lock file is cleaned up and acquire succeeds", async () => {
  await withTempDir(async (dir) => {
    const lockPath = `${dir}/.datastore.lock`;
    // Simulate a partial write (truncated JSON)
    await Deno.writeTextFile(lockPath, '{"holder":"crash@host","hos');
    await backdate(lockPath, 10_000);

    const lock = new FileLock(dir, { ttlMs: 5000, maxWaitMs: 2000 });
    await lock.acquire();

    const info = await lock.inspect();
    assertEquals(info !== null, true);
    assertEquals(info!.pid, Deno.pid);

    await lock.release();
  });
});

Deno.test("FileLock - contention message includes lock file path", async () => {
  await withTempDir(async (dir) => {
    // Set up a LogTape capture sink for the datastore.lock category
    capturedLogRecords.length = 0;
    await configure({
      sinks: {
        capture: (record: LogRecord) => {
          capturedLogRecords.push(record);
        },
      },
      loggers: [
        {
          category: ["datastore", "lock"],
          lowestLevel: "info",
          sinks: ["capture"],
        },
      ],
      reset: true,
    });

    const holder = new FileLock(dir, { ttlMs: 60_000 });
    await holder.acquire();

    const waiter = new FileLock(dir, {
      ttlMs: 60_000,
      retryIntervalMs: 50,
      maxWaitMs: 300,
    });

    await assertRejects(() => waiter.acquire(), LockTimeoutError);

    const lockPath = join(dir, ".datastore.lock");
    const messages = capturedLogRecords.map((r) =>
      r.message.map((p) => String(p)).join("")
    );
    const output = messages.join("\n");
    assertStringIncludes(output, lockPath);
    assertStringIncludes(output, "Waiting for lock");

    await holder.release();

    // Restore normal logging
    await initializeLogging({ _reset: true });
  });
});

Deno.test("FileLock.tryAcquire: takes a free lock and releases it", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { ttlMs: 5000 });
    assertEquals(await lock.tryAcquire(), true);
    assertEquals((await lock.inspect())?.pid, Deno.pid);
    await lock.release();
    assertEquals(await lock.inspect(), null);
  });
});

Deno.test("FileLock.tryAcquire: returns false while a live holder has the lock", async () => {
  await withTempDir(async (dir) => {
    const holder = new FileLock(dir, { ttlMs: 60_000 });
    await holder.acquire();
    const holderNonce = (await holder.inspect())?.nonce;

    const contender = new FileLock(dir, { ttlMs: 60_000 });
    assertEquals(await contender.tryAcquire(), false);
    // The holder's lock file is untouched.
    assertEquals((await holder.inspect())?.nonce, holderNonce);

    await holder.release();
    assertEquals(await contender.tryAcquire(), true);
    await contender.release();
  });
});

Deno.test("FileLock.tryAcquire: clears a stale holder and takes the lock", async () => {
  await withTempDir(async (dir) => {
    const staleLockInfo: LockInfo = {
      holder: "stale@host",
      hostname: "host",
      pid: 99999,
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      ttlMs: 5000,
    };
    await Deno.writeTextFile(
      join(dir, ".datastore.lock"),
      JSON.stringify(staleLockInfo, null, 2),
    );

    const lock = new FileLock(dir, { ttlMs: 5000 });
    assertEquals(await lock.tryAcquire(), true);
    assertEquals((await lock.inspect())?.pid, Deno.pid);
    await lock.release();
  });
});

Deno.test("FileLock.tryAcquire: a fresh unreadable lock file counts as held", async () => {
  await withTempDir(async (dir) => {
    // A live holder's file is empty between create and write
    // (swamp-club#2571), so a fresh empty file must not be cleared.
    const lockPath = join(dir, ".datastore.lock");
    await Deno.writeTextFile(lockPath, "");

    const lock = new FileLock(dir, { ttlMs: 60_000 });
    assertEquals(await lock.tryAcquire(), false);
    assertEquals(await Deno.readTextFile(lockPath), "");
  });
});
