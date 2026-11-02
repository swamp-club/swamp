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

import { assertEquals, assertRejects } from "@std/assert";
import { createDatastoreTestContext } from "./datastore_test_context.ts";

// --- resolveDatastorePath ---

Deno.test("createDatastoreTestContext: default datastore path", () => {
  const { provider } = createDatastoreTestContext();
  assertEquals(
    provider.resolveDatastorePath("/repo"),
    "/tmp/swamp-test-datastore",
  );
});

Deno.test("createDatastoreTestContext: custom datastore path", () => {
  const { provider } = createDatastoreTestContext({
    datastorePath: "/custom/path",
  });
  assertEquals(provider.resolveDatastorePath("/repo"), "/custom/path");
});

// --- resolveCachePath ---

Deno.test("createDatastoreTestContext: no cache path by default", () => {
  const { provider } = createDatastoreTestContext();
  assertEquals(provider.resolveCachePath, undefined);
});

Deno.test("createDatastoreTestContext: custom cache path", () => {
  const { provider } = createDatastoreTestContext({
    cachePath: "/cache/path",
  });
  assertEquals(provider.resolveCachePath!("/repo"), "/cache/path");
});

// --- Health verifier ---

Deno.test("createDatastoreTestContext: default healthy verifier", async () => {
  const { provider } = createDatastoreTestContext();
  const result = await provider.createVerifier().verify();
  assertEquals(result.healthy, true);
  assertEquals(result.datastoreType, "test");
  assertEquals(typeof result.latencyMs, "number");
});

Deno.test("createDatastoreTestContext: custom health result", async () => {
  const { provider } = createDatastoreTestContext({
    healthResult: {
      healthy: false,
      message: "Unreachable",
      datastoreType: "s3",
      latencyMs: 5000,
    },
  });
  const result = await provider.createVerifier().verify();
  assertEquals(result.healthy, false);
  assertEquals(result.message, "Unreachable");
  assertEquals(result.datastoreType, "s3");
  assertEquals(result.latencyMs, 5000);
});

// --- Lock: acquire/release ---

Deno.test("createDatastoreTestContext: lock acquire and release", async () => {
  const { provider, isLockHeld, getLockOperations } =
    createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  assertEquals(isLockHeld(), false);
  await lock.acquire();
  assertEquals(isLockHeld(), true);
  await lock.release();
  assertEquals(isLockHeld(), false);

  const ops = getLockOperations();
  assertEquals(ops.length, 2);
  assertEquals(ops[0].method, "acquire");
  assertEquals(ops[1].method, "release");
});

// --- Lock: withLock ---

Deno.test("createDatastoreTestContext: withLock holds and releases", async () => {
  const { provider, isLockHeld } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  let heldDuring = false;
  await lock.withLock(async () => {
    heldDuring = isLockHeld();
    await Promise.resolve();
  });

  assertEquals(heldDuring, true);
  assertEquals(isLockHeld(), false);
});

Deno.test("createDatastoreTestContext: withLock releases on error", async () => {
  const { provider, isLockHeld } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  try {
    await lock.withLock(async () => {
      await Promise.resolve();
      throw new Error("boom");
    });
  } catch {
    // expected
  }

  assertEquals(isLockHeld(), false);
});

// --- Lock: inspect ---

Deno.test("createDatastoreTestContext: inspect returns null when not held", async () => {
  const { provider } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");
  assertEquals(await lock.inspect(), null);
});

Deno.test("createDatastoreTestContext: inspect returns info when held", async () => {
  const { provider } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  await lock.acquire();
  const info = await lock.inspect();
  assertEquals(info !== null, true);
  assertEquals(info!.holder, "test-user@test-host");
  assertEquals(info!.pid, 1234);
  assertEquals(typeof info!.nonce, "string");
  await lock.release();
});

// --- Lock: forceRelease ---

Deno.test("createDatastoreTestContext: forceRelease with correct nonce", async () => {
  const { provider, isLockHeld } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  await lock.acquire();
  const info = await lock.inspect();
  const released = await lock.forceRelease(info!.nonce!);
  assertEquals(released, true);
  assertEquals(isLockHeld(), false);
});

Deno.test("createDatastoreTestContext: forceRelease with wrong nonce", async () => {
  const { provider, isLockHeld } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  await lock.acquire();
  const released = await lock.forceRelease("wrong-nonce");
  assertEquals(released, false);
  assertEquals(isLockHeld(), true);
  await lock.release();
});

// --- Lock: acquire fails ---

Deno.test("createDatastoreTestContext: lock acquire fails when configured", async () => {
  const { provider } = createDatastoreTestContext({ lockAcquireFails: true });
  const lock = provider.createLock("/ds");
  await assertRejects(() => lock.acquire(), Error, "Failed to acquire lock");
});

Deno.test("createDatastoreTestContext: withLock fails when acquire fails", async () => {
  const { provider } = createDatastoreTestContext({ lockAcquireFails: true });
  const lock = provider.createLock("/ds");
  await assertRejects(
    () => lock.withLock(async () => await Promise.resolve()),
    Error,
    "Failed to acquire lock",
  );
});

// --- Sync service ---

Deno.test("createDatastoreTestContext: no sync service by default", () => {
  const { provider } = createDatastoreTestContext();
  assertEquals(provider.createSyncService, undefined);
});

Deno.test("createDatastoreTestContext: sync service when enabled", async () => {
  const { provider, getSyncOperations } = createDatastoreTestContext({
    withSyncService: true,
  });

  const sync = provider.createSyncService!("/repo", "/cache");
  await sync.pullChanged();
  await sync.pushChanged();

  const ops = getSyncOperations();
  assertEquals(ops.length, 2);
  assertEquals(ops[0].method, "pullChanged");
  assertEquals(ops[1].method, "pushChanged");
});

// --- Lock operations recording ---

Deno.test("createDatastoreTestContext: getLockOperations returns a copy", async () => {
  const { provider, getLockOperations } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  await lock.acquire();
  const ops1 = getLockOperations();
  await lock.release();
  const ops2 = getLockOperations();

  assertEquals(ops1.length, 1);
  assertEquals(ops2.length, 2);
});

// --- Lock key tracking ---

Deno.test("createDatastoreTestContext: lock key is recorded in operations", async () => {
  const { provider, getLockOperations } = createDatastoreTestContext();
  const lock = provider.createLock("/ds", { lockKey: "my-lock" });

  await lock.acquire();
  await lock.release();

  assertEquals(getLockOperations()[0].lockKey, "my-lock");
});
