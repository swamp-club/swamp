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

import { assertEquals } from "@std/assert";
import { initializeLogging } from "../logging/logger.ts";
import {
  flushDatastoreSync,
  flushDatastoreSyncNamed,
  getRegisteredLockKeys,
  GLOBAL_LOCK_KEY,
  registerDatastoreSync,
  registerDatastoreSyncNamed,
} from "./datastore_sync_coordinator.ts";
import type { DistributedLock } from "../../domain/datastore/distributed_lock.ts";

// Initialize logging for tests
await initializeLogging({});

/** Fake lock that tracks acquire/release calls. */
class FakeLock implements DistributedLock {
  acquired = false;
  released = false;
  acquireCount = 0;
  releaseCount = 0;

  async acquire(): Promise<void> {
    this.acquired = true;
    this.acquireCount++;
    await Promise.resolve();
  }

  async release(): Promise<void> {
    this.released = true;
    this.releaseCount++;
    await Promise.resolve();
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  async inspect() {
    await Promise.resolve();
    return null;
  }

  async forceRelease(_nonce: string) {
    await Promise.resolve();
    return false;
  }
}

Deno.test("registerDatastoreSync uses GLOBAL_LOCK_KEY", async () => {
  const lock = new FakeLock();
  await registerDatastoreSync({ lock });

  const keys = getRegisteredLockKeys();
  assertEquals(keys.includes(GLOBAL_LOCK_KEY), true);
  assertEquals(lock.acquired, true);

  await flushDatastoreSync();
  assertEquals(lock.released, true);
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("registerDatastoreSyncNamed registers with custom key", async () => {
  const lock = new FakeLock();
  await registerDatastoreSyncNamed("model/aws-ec2/my-server", { lock });

  const keys = getRegisteredLockKeys();
  assertEquals(keys.includes("model/aws-ec2/my-server"), true);
  assertEquals(lock.acquired, true);

  await flushDatastoreSyncNamed("model/aws-ec2/my-server");
  assertEquals(lock.released, true);
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("multiple named entries can coexist", async () => {
  const lock1 = new FakeLock();
  const lock2 = new FakeLock();
  const lock3 = new FakeLock();

  await registerDatastoreSyncNamed("model/a", { lock: lock1 });
  await registerDatastoreSyncNamed("model/b", { lock: lock2 });
  await registerDatastoreSyncNamed("model/c", { lock: lock3 });

  assertEquals(getRegisteredLockKeys().length, 3);
  assertEquals(lock1.acquired, true);
  assertEquals(lock2.acquired, true);
  assertEquals(lock3.acquired, true);

  // Flush one
  await flushDatastoreSyncNamed("model/b");
  assertEquals(lock2.released, true);
  assertEquals(getRegisteredLockKeys().length, 2);

  // Flush all remaining
  await flushDatastoreSync();
  assertEquals(lock1.released, true);
  assertEquals(lock3.released, true);
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("flushDatastoreSyncNamed is no-op for unknown key", async () => {
  await flushDatastoreSyncNamed("nonexistent");
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("flushDatastoreSync flushes all entries", async () => {
  const globalLock = new FakeLock();
  const modelLock = new FakeLock();

  await registerDatastoreSync({ lock: globalLock });
  await registerDatastoreSyncNamed("model/x", { lock: modelLock });

  assertEquals(getRegisteredLockKeys().length, 2);

  await flushDatastoreSync();
  assertEquals(globalLock.released, true);
  assertEquals(modelLock.released, true);
  assertEquals(getRegisteredLockKeys().length, 0);
});
