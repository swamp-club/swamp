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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { hostname } from "node:os";
import { waitFor } from "@swamp-club/swamp-testing";
import { plantV3WriterLease } from "./v3_writer_lock_test_helpers.ts";
import { FileLock } from "../persistence/file_lock.ts";
import { FileSystemControlPlaneStore } from "../persistence/fs_control_plane_store.ts";
import {
  fenceKey,
  releasedKey,
  WriterFencedError,
} from "../../domain/datastore_v3/writer_lease.ts";
import {
  acquireV3WriterLock,
  assertV3WriterCurrent,
  checkV3WriterLease,
  holdsV3WriterLock,
  tryAcquireV3WriterLock,
  V3_LEGACY_WRITER_LOCK_KEY,
  V3_WRITER_LEASE_DIR,
  V3WriterBusyError,
  v3WriterFence,
  type V3WriterFenceStore,
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

/** A `commits.db` writer fence kept in memory. */
function memoryFenceStore(initial?: number): V3WriterFenceStore & {
  raised: number[];
} {
  let fence = initial;
  const raised: number[] = [];
  return {
    raised,
    writerFence: () => fence,
    raiseWriterFence(next) {
      if (fence !== undefined && next < fence) {
        return Promise.reject(new WriterFencedError(next, fence));
      }
      fence = next;
      raised.push(next);
      return Promise.resolve();
    },
  };
}

/** A fence record as another process left it. */
async function plantFence(
  dir: string,
  fence: number,
  host: string,
  options: { acquiredAt?: Date } = {},
): Promise<void> {
  await new FileSystemControlPlaneStore(dir).put(
    fenceKey(fence),
    new TextEncoder().encode(JSON.stringify({
      fence,
      holder: "other",
      hostname: host,
      // No process here has this pid.
      pid: 2147483647,
      nonce: crypto.randomUUID(),
      ttlMs: 60_000,
      acquiredAt: (options.acquiredAt ?? new Date()).toISOString(),
    })),
  );
}

Deno.test("acquireV3WriterLock: one hold per process, released by the last caller", async () => {
  await withTempDir(async (dir) => {
    const handle = v3WriterLockHandle(dir);
    const first = await acquireV3WriterLock(dir);
    const second = await acquireV3WriterLock(dir);
    assert(holdsV3WriterLock(dir));
    assertEquals(v3WriterFence(dir), 1);
    assertEquals((await handle.inspect())?.pid, Deno.pid);

    await first();
    assert(holdsV3WriterLock(dir), "the second caller still holds it");
    assertEquals((await handle.inspect())?.fence, 1);

    await second();
    assertEquals(holdsV3WriterLock(dir), false);
    assertEquals(v3WriterFence(dir), undefined);
    assertEquals(await handle.inspect(), null, "released");
    // A release is idempotent.
    await second();
  });
});

Deno.test("acquireV3WriterLock: each acquisition takes the next fence, and records it in commits.db", async () => {
  await withTempDir(async (dir) => {
    const fences = memoryFenceStore();
    for (const expected of [1, 2, 3]) {
      const release = await acquireV3WriterLock(dir, { fenceStore: fences });
      assertEquals(v3WriterFence(dir), expected);
      await release();
    }
    assertEquals(fences.raised, [1, 2, 3]);
  });
});

Deno.test("acquireV3WriterLock: the next fence is above the one commits.db has seen, even when the lease's records are gone", async () => {
  await withTempDir(async (dir) => {
    const fences = memoryFenceStore(7);
    const release = await acquireV3WriterLock(dir, { fenceStore: fences });
    try {
      assertEquals(v3WriterFence(dir), 8);
    } finally {
      await release();
    }
  });
});

Deno.test("acquireV3WriterLock: a fence commits.db refuses releases the lease and leaves no hold behind", async () => {
  await withTempDir(async (dir) => {
    const failing: V3WriterFenceStore = {
      writerFence: () => undefined,
      raiseWriterFence: () => Promise.reject(new WriterFencedError(1, 9)),
    };
    await assertRejects(
      () => acquireV3WriterLock(dir, { fenceStore: failing }),
      WriterFencedError,
    );
    assertEquals(holdsV3WriterLock(dir), false);
    assertEquals(v3WriterFence(dir), undefined);
    assertEquals(await v3WriterLockHandle(dir).inspect(), null);
    // Nothing in the process joins the failed hold: the next caller takes a
    // fresh fence.
    const release = await acquireV3WriterLock(dir);
    try {
      assertEquals(v3WriterFence(dir), 2);
    } finally {
      await release();
    }
  });
});

Deno.test("acquireV3WriterLock: another process's hold refuses with its holder named", async () => {
  await withTempDir(async (dir) => {
    await plantFence(dir, 1, `other-host-${crypto.randomUUID()}`);
    const error = await assertRejects(
      () => acquireV3WriterLock(dir, { maxWaitMs: 100 }),
      V3WriterBusyError,
    );
    assertEquals(error.code, "datastore_v3_writer_busy");
    assert(error.message.includes("(other, pid 2147483647)"));
    assertEquals(holdsV3WriterLock(dir), false);

    // Once the other process lets go, this one takes the next fence.
    await new FileSystemControlPlaneStore(dir).putIfAbsent(
      releasedKey(1),
      new TextEncoder().encode("{}"),
    );
    const release = await acquireV3WriterLock(dir, { maxWaitMs: 1000 });
    try {
      assertEquals(v3WriterFence(dir), 2);
    } finally {
      await release();
    }
  });
});

Deno.test("acquireV3WriterLock: another host's holder is alive until its lease expires, whatever its pid here", async () => {
  await withTempDir(async (dir) => {
    await plantFence(dir, 1, `other-host-${crypto.randomUUID()}`);
    await assertRejects(
      () => acquireV3WriterLock(dir, { maxWaitMs: 100 }),
      V3WriterBusyError,
    );
  });
});

Deno.test("acquireV3WriterLock: another host's holder whose lease expired is taken over", async () => {
  await withTempDir(async (dir) => {
    await plantFence(dir, 4, `other-host-${crypto.randomUUID()}`, {
      acquiredAt: new Date(Date.now() - 600_000),
    });
    const release = await acquireV3WriterLock(dir, { maxWaitMs: 100 });
    try {
      assertEquals(v3WriterFence(dir), 5);
    } finally {
      await release();
    }
  });
});

Deno.test("acquireV3WriterLock: a holder on this host whose process is gone is taken over at once", async () => {
  await withTempDir(async (dir) => {
    await plantFence(dir, 1, hostname());
    const release = await acquireV3WriterLock(dir, { maxWaitMs: 0 });
    try {
      assertEquals(v3WriterFence(dir), 2);
    } finally {
      await release();
    }
  });
});

Deno.test("acquireV3WriterLock: a live Phase 3 writer lock refuses the lease", async () => {
  await withTempDir(async (dir) => {
    const legacy = new FileLock(dir, { lockKey: V3_LEGACY_WRITER_LOCK_KEY });
    await legacy.acquire();
    try {
      const error = await assertRejects(
        () => acquireV3WriterLock(dir, { maxWaitMs: 100 }),
        V3WriterBusyError,
      );
      assert(error.message.includes(`pid ${Deno.pid}`));
      // Status shows the old lock while it is the one held.
      assertEquals((await v3WriterLockHandle(dir).inspect())?.pid, Deno.pid);
    } finally {
      await legacy.release();
    }
    const release = await acquireV3WriterLock(dir, { maxWaitMs: 100 });
    await release();
  });
});

Deno.test("acquireV3WriterLock: a Phase 3 lock past its TTL does not refuse the lease, even naming a live pid here", async () => {
  await withTempDir(async (dir) => {
    // A crashed Phase 3 swamp's lock whose pid was reused by a live process.
    await Deno.mkdir(join(dir, "_control"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, V3_LEGACY_WRITER_LOCK_KEY),
      JSON.stringify({
        holder: "old",
        hostname: hostname(),
        pid: Deno.pid,
        acquiredAt: new Date(Date.now() - 600_000).toISOString(),
        ttlMs: 30_000,
        nonce: crypto.randomUUID(),
      }),
    );
    const release = await acquireV3WriterLock(dir, { maxWaitMs: 0 });
    await release();
  });
});

Deno.test("v3WriterLockHandle: force release marks the lease released, and its holder finds itself fenced", async () => {
  await withTempDir(async (dir) => {
    const release = await acquireV3WriterLock(dir);
    try {
      const handle = v3WriterLockHandle(dir);
      const info = await handle.inspect();
      assertEquals(info?.fence, 1);
      assertEquals(await handle.forceRelease("not-the-nonce"), false);
      assert(await handle.forceRelease(info!.nonce!));
      assertEquals(await handle.inspect(), null);

      // The next writer takes fence 2; the old holder's next check fails.
      const other = await tryAcquireV3WriterLockElsewhere(dir);
      assertEquals(other, 2);
      await assertRejects(() => checkV3WriterLease(dir), WriterFencedError);
      assertThrows(() => assertV3WriterCurrent(dir), WriterFencedError);
    } finally {
      await release();
    }
  });
});

/**
 * Takes the next fence as another process would, by creating its record
 * directly, and returns it.
 */
async function tryAcquireV3WriterLockElsewhere(dir: string): Promise<number> {
  const store = new FileSystemControlPlaneStore(dir);
  const keys = await store.list("writer/");
  const next = keys.filter((key) => key.includes("fence-")).length + 1;
  await plantFence(dir, next, `other-host-${crypto.randomUUID()}`);
  return next;
}

Deno.test("tryAcquireV3WriterLock: takes the lease without waiting, or resolves undefined when it is held", async () => {
  await withTempDir(async (dir) => {
    const release = await tryAcquireV3WriterLock(dir);
    assert(release !== undefined);
    assertEquals(holdsV3WriterLock(dir), false, "the hold is not shared");
    assertEquals(await tryAcquireV3WriterLock(dir), undefined);
    await release();

    const held = await acquireV3WriterLock(dir);
    try {
      assertEquals(
        await tryAcquireV3WriterLock(dir),
        undefined,
        "this process already writes",
      );
    } finally {
      await held();
    }
  });
});

Deno.test("acquireV3WriterLock: once the process's hold is lost, the next acquire waits for the other writer and takes a higher fence", async () => {
  await withTempDir(async (dir) => {
    // serve's lifetime hold.
    const lifetime = await acquireV3WriterLock(dir);
    try {
      assertEquals(v3WriterFence(dir), 1);
      const other = await plantV3WriterLease(dir, { pid: Deno.pid });
      await assertRejects(() => checkV3WriterLease(dir), WriterFencedError);

      // While the other writer holds it, a new acquire is refused as busy.
      await assertRejects(
        () => acquireV3WriterLock(dir, { maxWaitMs: 0 }),
        V3WriterBusyError,
      );
      assertThrows(() => assertV3WriterCurrent(dir), WriterFencedError);

      // Once it is done, the process takes a fresh lease, and the lifetime
      // hold carries on under it.
      await other.release();
      const next = await acquireV3WriterLock(dir, { maxWaitMs: 0 });
      assertEquals(v3WriterFence(dir), other.fence + 1);
      assertV3WriterCurrent(dir);
      await next();
      assert(holdsV3WriterLock(dir), "the lifetime hold still holds");
      assertEquals(v3WriterFence(dir), other.fence + 1);
    } finally {
      await lifetime();
    }
    assertEquals(await v3WriterLockHandle(dir).inspect(), null);
  });
});

Deno.test("acquireV3WriterLock: a retake that fails after every other caller released ends the hold", async () => {
  await withTempDir(async (dir) => {
    const first = await acquireV3WriterLock(dir);
    const other = await plantV3WriterLease(dir, { pid: Deno.pid });
    await assertRejects(() => checkV3WriterLease(dir), WriterFencedError);
    try {
      // A second caller waits to take the lost hold again; the first
      // releases meanwhile; the wait runs out.
      const second = acquireV3WriterLock(dir, { maxWaitMs: 200 });
      await first();
      await assertRejects(() => second, V3WriterBusyError);
      // Nothing in the process holds the datastore, so nothing renews or
      // takes the lease back.
      assertEquals(holdsV3WriterLock(dir), false);
      const probe = await tryAcquireV3WriterLock(dir);
      assertEquals(probe, undefined, "the other writer still holds it");
      await other.release();
      const taken = await tryAcquireV3WriterLock(dir);
      assert(taken !== undefined, "no stranded hold blocks the next writer");
      await taken();
    } finally {
      await other.release();
    }
  });
});

Deno.test("acquireV3WriterLock: a caller that waits is not refused by an attempt it joined that did not wait", async () => {
  await withTempDir(async (dir) => {
    const lifetime = await acquireV3WriterLock(dir);
    const other = await plantV3WriterLease(dir, { pid: Deno.pid });
    try {
      await assertRejects(() => checkV3WriterLease(dir), WriterFencedError);
      // The first caller's attempt does not wait, as the renewal timer's
      // does not; the second joins it, but is willing to wait.
      const quick = acquireV3WriterLock(dir, { maxWaitMs: 0 });
      const patient = acquireV3WriterLock(dir, { maxWaitMs: 5_000 });
      await assertRejects(() => quick, V3WriterBusyError);
      await other.release();
      const next = await patient;
      assert(v3WriterFence(dir)! > other.fence);
      await next();
    } finally {
      await other.release();
      await lifetime();
    }
  });
});

Deno.test("tryAcquireV3WriterLock: the recovery's hold is renewed until it is released", async () => {
  await withTempDir(async (dir) => {
    const release = await tryAcquireV3WriterLock(dir, { ttlMs: 30 });
    assert(release !== undefined);
    const heartbeat = join(dir, V3_WRITER_LEASE_DIR, "heartbeat-000000000001");
    try {
      // Taking the lease writes the first heartbeat; a renewal rewrites it.
      const first = await Deno.readTextFile(heartbeat);
      await waitFor(
        () => Deno.readTextFile(heartbeat).then((now) => now !== first),
        "the recovery's hold renewed",
      );
    } finally {
      await release();
    }
    // Released, and renewing no more.
    await assertRejects(() => Deno.stat(heartbeat), Deno.errors.NotFound);
    assertEquals(await v3WriterLockHandle(dir).inspect(), null);
  });
});

Deno.test("v3WriterLockHandle: the lease's records live under _control/writer", async () => {
  await withTempDir(async (dir) => {
    const release = await acquireV3WriterLock(dir);
    await release();
    const names: string[] = [];
    for await (const entry of Deno.readDir(join(dir, V3_WRITER_LEASE_DIR))) {
      names.push(entry.name);
    }
    assertEquals(names.sort(), [
      "fence-000000000001",
      "released-000000000001",
    ]);
  });
});
