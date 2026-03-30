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
import { S3Lock } from "./s3_lock.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import type { S3Client } from "./s3_client.ts";
import type { LockInfo } from "../../domain/datastore/distributed_lock.ts";

/** In-memory mock of S3Client for testing lock mechanics. */
function createMockS3Client(): S3Client & { storage: Map<string, Uint8Array> } {
  const storage = new Map<string, Uint8Array>();
  const putTimes = new Map<string, Date>();

  return {
    storage,

    putObject(key: string, body: Uint8Array): Promise<void> {
      storage.set(key, body);
      putTimes.set(key, new Date());
      return Promise.resolve();
    },

    putObjectConditional(
      key: string,
      body: Uint8Array,
    ): Promise<boolean> {
      if (storage.has(key)) {
        return Promise.resolve(false);
      }
      storage.set(key, body);
      putTimes.set(key, new Date());
      return Promise.resolve(true);
    },

    getObject(key: string): Promise<Uint8Array> {
      const data = storage.get(key);
      if (!data) return Promise.reject(new Error(`NoSuchKey: ${key}`));
      return Promise.resolve(data);
    },

    deleteObject(key: string): Promise<void> {
      storage.delete(key);
      putTimes.delete(key);
      return Promise.resolve();
    },

    headObject(
      key: string,
    ): Promise<{ exists: boolean; size?: number; lastModified?: Date }> {
      const data = storage.get(key);
      if (!data) return Promise.resolve({ exists: false });
      return Promise.resolve({
        exists: true,
        size: data.length,
        lastModified: putTimes.get(key) ?? new Date(),
      });
    },
  } as unknown as S3Client & { storage: Map<string, Uint8Array> };
}

Deno.test("S3Lock - acquire and release", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });

  await lock.acquire();

  // Lock object should exist in storage
  assertEquals(mock.storage.has(".datastore.lock"), true);
  const info = await lock.inspect();
  assertEquals(info !== null, true);
  assertEquals(info!.pid, Deno.pid);

  await lock.release();

  // Lock object should be deleted
  assertEquals(mock.storage.has(".datastore.lock"), false);
});

Deno.test("S3Lock - release is idempotent", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });

  await lock.acquire();
  await lock.release();
  await lock.release(); // Should not throw
});

Deno.test("S3Lock - withLock executes callback and releases", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });

  const result = await lock.withLock(() => {
    assertEquals(mock.storage.has(".datastore.lock"), true);
    return Promise.resolve(42);
  });

  assertEquals(result, 42);
  assertEquals(mock.storage.has(".datastore.lock"), false);
});

Deno.test("S3Lock - withLock releases on error", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });

  try {
    await lock.withLock(() => {
      return Promise.reject(new Error("test error"));
    });
  } catch {
    // Expected
  }

  assertEquals(mock.storage.has(".datastore.lock"), false);
});

Deno.test("S3Lock - second acquire times out when lock is held", async () => {
  const mock = createMockS3Client();
  const lock1 = new S3Lock(mock, { ttlMs: 60_000 });
  const lock2 = new S3Lock(mock, {
    ttlMs: 60_000,
    retryIntervalMs: 50,
    maxWaitMs: 300,
  });

  await lock1.acquire();

  await assertRejects(
    () => lock2.acquire(),
    LockTimeoutError,
  );

  await lock1.release();
});

Deno.test("S3Lock - stale lock is force-acquired", async () => {
  const mock = createMockS3Client();

  // Place a stale lock: acquiredAt is in the past, TTL is short
  const staleLock: LockInfo = {
    holder: "stale@host",
    hostname: "host",
    pid: 99999,
    acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    ttlMs: 5000,
  };
  const body = new TextEncoder().encode(JSON.stringify(staleLock, null, 2));
  mock.storage.set(".datastore.lock", body);

  // New lock should detect staleness via headObject lastModified
  // We need to set a stale lastModified — override headObject behavior
  const originalHead = mock.headObject.bind(mock);
  (mock as unknown as Record<string, unknown>).headObject = (key: string) => {
    if (key === ".datastore.lock") {
      return Promise.resolve({
        exists: true,
        size: body.length,
        lastModified: new Date(Date.now() - 120_000), // 2 minutes ago
      });
    }
    return originalHead(key);
  };

  const lock = new S3Lock(mock, { ttlMs: 5000 });
  await lock.acquire();

  const info = await lock.inspect();
  assertEquals(info !== null, true);
  assertEquals(info!.pid, Deno.pid);

  await lock.release();
});

Deno.test("S3Lock - inspect returns null when no lock exists", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });
  const info = await lock.inspect();
  assertEquals(info, null);
});

Deno.test("S3Lock - forceRelease deletes lock when nonce matches", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });
  await lock.acquire();

  const info = await lock.inspect();
  assertEquals(info !== null, true);

  const released = await lock.forceRelease(info!.nonce!);
  assertEquals(released, true);

  // Lock should be gone
  assertEquals(mock.storage.has(".datastore.lock"), false);

  // Clean up internal state (heartbeat)
  await lock.release();
});

Deno.test("S3Lock - forceRelease returns false when nonce does not match", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });
  await lock.acquire();

  const released = await lock.forceRelease("wrong-nonce");
  assertEquals(released, false);

  // Lock should still exist
  assertEquals(mock.storage.has(".datastore.lock"), true);

  await lock.release();
});

Deno.test("S3Lock - forceRelease returns false when no lock exists", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });

  const released = await lock.forceRelease("some-nonce");
  assertEquals(released, false);
});

Deno.test("S3Lock - custom lock key", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, {
    lockKey: "custom.lock",
    ttlMs: 5000,
  });

  await lock.acquire();
  assertEquals(mock.storage.has("custom.lock"), true);
  assertEquals(mock.storage.has(".datastore.lock"), false);

  await lock.release();
});

Deno.test("S3Lock - release cleans up lock even during heartbeat", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });

  await lock.acquire();
  assertEquals(mock.storage.has(".datastore.lock"), true);

  // Release should clean up — the releasing flag prevents extend() from
  // recreating the lock after release() deletes it
  await lock.release();
  assertEquals(mock.storage.has(".datastore.lock"), false);

  // Wait briefly to ensure no heartbeat recreates the lock
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(mock.storage.has(".datastore.lock"), false);
});

Deno.test("S3Lock - times out when stale lock cannot be deleted", async () => {
  const mock = createMockS3Client();

  // Place a stale lock
  const staleLock: LockInfo = {
    holder: "stale@host",
    hostname: "host",
    pid: 99999,
    acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    ttlMs: 5000,
  };
  const body = new TextEncoder().encode(JSON.stringify(staleLock, null, 2));
  mock.storage.set(".datastore.lock", body);

  // Override headObject to return stale lastModified
  const originalHead = mock.headObject.bind(mock);
  (mock as unknown as Record<string, unknown>).headObject = (key: string) => {
    if (key === ".datastore.lock") {
      return Promise.resolve({
        exists: true,
        size: body.length,
        lastModified: new Date(Date.now() - 120_000),
      });
    }
    return originalHead(key);
  };

  // Override deleteObject to always fail — simulates persistent S3 delete failure
  (mock as unknown as Record<string, unknown>).deleteObject = () => {
    return Promise.reject(new Error("Simulated S3 delete failure"));
  };

  const lock = new S3Lock(mock, {
    ttlMs: 5000,
    retryIntervalMs: 10,
    maxWaitMs: 200,
  });

  await assertRejects(
    () => lock.acquire(),
    LockTimeoutError,
  );
});

Deno.test("S3Lock - timeout check fires even during stale lock retry loop", async () => {
  const mock = createMockS3Client();

  // Place a stale lock
  const staleLock: LockInfo = {
    holder: "stale@host",
    hostname: "host",
    pid: 99999,
    acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    ttlMs: 100,
  };
  const body = new TextEncoder().encode(JSON.stringify(staleLock, null, 2));
  mock.storage.set(".datastore.lock", body);

  // Override headObject to return stale lastModified
  (mock as unknown as Record<string, unknown>).headObject = (key: string) => {
    if (key === ".datastore.lock") {
      return Promise.resolve({
        exists: true,
        size: body.length,
        lastModified: new Date(Date.now() - 120_000),
      });
    }
    return Promise.resolve({ exists: false });
  };

  // deleteObject "succeeds" but lock reappears (simulates S3 versioning issue)
  (mock as unknown as Record<string, unknown>).deleteObject = () => {
    // Don't actually remove from storage — simulates delete marker not
    // preventing conditional put from failing
    return Promise.resolve();
  };

  // putObjectConditional always fails (lock "still exists" due to versioning)
  (mock as unknown as Record<string, unknown>).putObjectConditional = () => {
    return Promise.resolve(false);
  };

  const lock = new S3Lock(mock, {
    ttlMs: 100,
    retryIntervalMs: 10,
    maxWaitMs: 200,
  });

  const start = Date.now();
  await assertRejects(
    () => lock.acquire(),
    LockTimeoutError,
  );
  const elapsed = Date.now() - start;

  // Should timeout within a reasonable margin of maxWaitMs, not hang forever
  assertEquals(
    elapsed < 1000,
    true,
    `Expected timeout within 1s, took ${elapsed}ms`,
  );
});
