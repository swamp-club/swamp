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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ReadWriteLock } from "./read_write_lock.ts";

/** Records whether a pending acquisition has been granted. */
function track(
  promise: Promise<void>,
): { granted: boolean; done: Promise<void> } {
  const state = { granted: false, done: Promise.resolve() };
  state.done = promise.then(() => {
    state.granted = true;
  });
  return state;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

Deno.test("ReadWriteLock: shared holders run together", async () => {
  const lock = new ReadWriteLock();
  await lock.acquireShared();
  await lock.acquireShared();
  assertEquals(lock.sharedHolders, 2);
  assertEquals(lock.waiters, 0);
});

Deno.test("ReadWriteLock: exclusive waits for shared holders to drain", async () => {
  const lock = new ReadWriteLock();
  await lock.acquireShared();
  await lock.acquireShared();

  const exclusive = track(lock.acquire());
  await flushMicrotasks();
  assertEquals(exclusive.granted, false);
  assertEquals(lock.waiters, 1);

  lock.releaseShared();
  await flushMicrotasks();
  assertEquals(exclusive.granted, false);

  lock.releaseShared();
  await exclusive.done;
  assertEquals(lock.exclusiveHeld, true);
});

Deno.test("ReadWriteLock: shared waits while exclusive is held", async () => {
  const lock = new ReadWriteLock();
  await lock.acquire();

  const shared = track(lock.acquireShared());
  await flushMicrotasks();
  assertEquals(shared.granted, false);

  lock.release();
  await shared.done;
  assertEquals(lock.sharedHolders, 1);
});

Deno.test("ReadWriteLock: a queued exclusive blocks later shared acquirers", async () => {
  const lock = new ReadWriteLock();
  await lock.acquireShared();

  const exclusive = track(lock.acquire());
  const lateShared = track(lock.acquireShared());
  await flushMicrotasks();
  // The late shared acquirer is compatible with the current shared holder,
  // but granting it would let a stream of shared holders starve the writer.
  assertEquals(lateShared.granted, false);
  assertEquals(lock.waiters, 2);

  lock.releaseShared();
  await exclusive.done;
  assertEquals(lateShared.granted, false);

  lock.release();
  await lateShared.done;
  assertEquals(lock.sharedHolders, 1);
});

Deno.test("ReadWriteLock: consecutive queued shared acquirers are granted together", async () => {
  const lock = new ReadWriteLock();
  await lock.acquire();

  const a = track(lock.acquireShared());
  const b = track(lock.acquireShared());
  const c = track(lock.acquire());

  lock.release();
  await a.done;
  await b.done;
  await flushMicrotasks();
  assertEquals(lock.sharedHolders, 2);
  assertEquals(c.granted, false);
});

Deno.test("ReadWriteLock: tryAcquire succeeds only when idle", async () => {
  const lock = new ReadWriteLock();
  assertEquals(lock.tryAcquire(), true);
  assertEquals(lock.tryAcquire(), false);
  lock.release();

  await lock.acquireShared();
  assertEquals(lock.tryAcquire(), false);
  lock.releaseShared();
  assertEquals(lock.tryAcquire(), true);
});

Deno.test("ReadWriteLock: tryAcquire never queues and never jumps the queue", async () => {
  const lock = new ReadWriteLock();
  await lock.acquireShared();
  const exclusive = track(lock.acquire());

  lock.releaseShared();
  await exclusive.done;
  lock.release();

  // Idle again: nothing queued, so tryAcquire may take it.
  assertEquals(lock.tryAcquire(), true);
  lock.release();

  await lock.acquire();
  const queued = track(lock.acquireShared());
  assertEquals(lock.tryAcquire(), false);
  assertEquals(lock.waiters, 1);
  lock.release();
  await queued.done;
});

Deno.test("ReadWriteLock: acquire rejects immediately when already aborted", async () => {
  const lock = new ReadWriteLock();
  const controller = new AbortController();
  controller.abort();
  await assertRejects(() => lock.acquire(controller.signal));
  await assertRejects(() => lock.acquireShared(controller.signal));
  assertEquals(lock.waiters, 0);
  assertEquals(lock.tryAcquire(), true);
});

Deno.test("ReadWriteLock: aborting a queued waiter removes it", async () => {
  const lock = new ReadWriteLock();
  await lock.acquire();
  const controller = new AbortController();
  const pending = lock.acquireShared(controller.signal);
  assertEquals(lock.waiters, 1);

  controller.abort();
  await assertRejects(() => pending);
  assertEquals(lock.waiters, 0);

  lock.release();
  assertEquals(lock.exclusiveHeld, false);
  assertEquals(lock.sharedHolders, 0);
});

Deno.test("ReadWriteLock: aborting a queued exclusive at the head admits the shared waiters behind it", async () => {
  const lock = new ReadWriteLock();
  await lock.acquireShared();

  const controller = new AbortController();
  const exclusive = lock.acquire(controller.signal);
  const behind = track(lock.acquireShared());
  await flushMicrotasks();
  assertEquals(behind.granted, false);

  controller.abort();
  await assertRejects(() => exclusive);
  await behind.done;
  assertEquals(lock.sharedHolders, 2);
  assertEquals(lock.waiters, 0);
});

Deno.test("ReadWriteLock: abort after grant has no effect", async () => {
  const lock = new ReadWriteLock();
  const controller = new AbortController();
  await lock.acquire(controller.signal);
  controller.abort();
  assertEquals(lock.exclusiveHeld, true);
  lock.release();
  assertEquals(lock.exclusiveHeld, false);
});

Deno.test("ReadWriteLock: release without a holder throws", () => {
  const lock = new ReadWriteLock();
  assertThrows(() => lock.release(), Error, "without an exclusive holder");
  assertThrows(() => lock.releaseShared(), Error, "without a shared holder");
});
