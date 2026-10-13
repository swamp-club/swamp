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

/**
 * The writer lease over its stores (swamp-club#3359): a filesystem
 * datastore's control plane on a real temp directory, and the in-memory
 * remote's sync-service and datastore-wide stores, standing in for S3, GCS
 * and extension datastores (swamp-club#3364). One case list runs against
 * each.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import {
  WRITER_LEASE_CLOCK_SKEW_MS,
  WriterFencedError,
  WriterLease,
  WriterLeaseBusyError,
  type WriterLeaseStore,
} from "../../domain/datastore_v3/writer_lease.ts";
import { FileSystemControlPlaneStore } from "../persistence/fs_control_plane_store.ts";
import { isAtomicControlPlaneStore } from "../persistence/control_plane_signal_wait_store.ts";
import { datastoreWriterLeaseStore } from "./datastore_writer_lease_store.ts";

const TTL = 30_000;
const START = Date.parse("2026-10-13T12:00:00.000Z");

/** A clock the cases move by hand. */
class Clock {
  now = START;
  advance(ms: number): void {
    this.now += ms;
  }
}

interface Writer {
  readonly lease: WriterLease;
  readonly pid: number;
}

/** Writers sharing one store and one clock, each its own process. */
function writers(store: WriterLeaseStore, clock: Clock, host = "host-a") {
  const gone = new Set<number>();
  let pids = 100;
  return {
    gone,
    writer(options: { hostname?: string } = {}): Writer {
      const pid = pids++;
      const hostname = options.hostname ?? host;
      return {
        pid,
        lease: new WriterLease({
          store,
          holder: { holder: `test@${hostname}`, hostname, pid },
          ttlMs: TTL,
          now: () => clock.now,
          // Waiting moves the clock instead of sleeping.
          delay: (ms) => {
            clock.advance(ms);
            return Promise.resolve();
          },
          processGone: (other) => gone.has(other),
          nonce: () => crypto.randomUUID(),
        }),
      };
    },
  };
}

type OpenStore = () => Promise<
  { store: WriterLeaseStore; close: () => Promise<void> }
>;

const STORES: [string, OpenStore][] = [
  ["filesystem", async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-writer-lease-" });
    return {
      store: new FileSystemControlPlaneStore(dir),
      close: async () => {
        if (Deno.build.os === "windows") {
          await Deno.remove(dir, { recursive: true }).catch(() => {});
        } else {
          await Deno.remove(dir, { recursive: true });
        }
      },
    };
  }],
  ["in-memory remote", () => {
    const store = createInMemoryRemote({ controlPlane: true })
      .connect("/cache/writer-lease").controlPlaneStore!();
    if (!isAtomicControlPlaneStore(store)) {
      throw new Error("the in-memory remote has no putIfAbsent");
    }
    return Promise.resolve({ store, close: () => Promise.resolve() });
  }],
  ["datastore-wide store", () => {
    // The provider's writable datastore-wide control plane, as the lease
    // binds it on a bucket (swamp-club#3364).
    const remote = createInMemoryRemote({ controlPlane: true });
    const store = datastoreWriterLeaseStore({
      datastoreWideLease: true,
      datastoreControlPlaneStore: () => remote.datastoreControlPlaneStore!(),
    }, "@test/remote");
    return Promise.resolve({ store, close: () => Promise.resolve() });
  }],
];

/** The body of a stray key: never one swamp wrote. */
const STRAY = new TextEncoder().encode("{}");

const CASES: [
  string,
  (store: WriterLeaseStore, clock: Clock) => Promise<void>,
][] = [
  [
    "acquire takes fence 1, then each later acquisition the next",
    async (store, clock) => {
      const { writer } = writers(store, clock);
      const a = writer();
      const first = await a.lease.acquire({ maxWaitMs: 0 });
      assertEquals(first.fence, 1);
      await first.release();
      const second = await writer().lease.acquire({ maxWaitMs: 0 });
      assertEquals(second.fence, 2);
      await second.release();
    },
  ],
  ["of racing acquirers exactly one wins", async (store, clock) => {
    const { writer } = writers(store, clock);
    const racers = Array.from({ length: 6 }, () => writer());
    const outcomes = await Promise.allSettled(
      racers.map((racer) => racer.lease.acquire({ maxWaitMs: 0 })),
    );
    const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
    assertEquals(won.length, 1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        assert(outcome.reason instanceof WriterLeaseBusyError);
      }
    }
  }],
  [
    "a held lease refuses another writer, naming its holder",
    async (store, clock) => {
      const { writer } = writers(store, clock);
      const a = writer();
      const hold = await a.lease.acquire({ maxWaitMs: 0 });
      const error = await assertRejects(
        () => writer().lease.acquire({ maxWaitMs: 5_000 }),
        WriterLeaseBusyError,
      );
      assertEquals(error.inspection.fence, 1);
      assertEquals(error.inspection.record?.pid, a.pid);
      assertEquals(error.waitedMs >= 5_000, true);
      await hold.release();
    },
  ],
  ["a renewed lease stays held past its first TTL", async (store, clock) => {
    const { writer } = writers(store, clock);
    const hold = await writer().lease.acquire({ maxWaitMs: 0 });
    for (let i = 0; i < 5; i++) {
      clock.advance(TTL / 3);
      assertEquals(await hold.renew(), "held");
    }
    await assertRejects(
      () => writer().lease.acquire({ maxWaitMs: 0 }),
      WriterLeaseBusyError,
    );
    await hold.release();
  }],
  [
    "an expired lease is taken over with the next fence, and its zombie is fenced",
    async (store, clock) => {
      const { writer } = writers(store, clock);
      const zombie = await writer({ hostname: "host-z" }).lease.acquire({
        maxWaitMs: 0,
      });
      clock.advance(TTL + WRITER_LEASE_CLOCK_SKEW_MS + 1);
      const taker = await writer().lease.acquire({ maxWaitMs: 0 });
      assertEquals(taker.fence, zombie.fence + 1);

      // The zombie wakes: its renewal writes nothing and finds itself fenced.
      assertEquals(await zombie.renew(), "fenced");
      assert(zombie.lost instanceof WriterFencedError);
      await assertRejects(() => zombie.assertCurrent(), WriterFencedError);
      assertEquals(await taker.renew(), "held");
      // The zombie's release does not release the taker's fence.
      await zombie.release();
      await taker.assertCurrent();
      await taker.release();
    },
  ],
  [
    "a holder on this host whose process is gone is taken over at once",
    async (store, clock) => {
      const { writer, gone } = writers(store, clock);
      const crashed = writer();
      await crashed.lease.acquire({ maxWaitMs: 0 });
      gone.add(crashed.pid);
      const taker = await writer().lease.acquire({ maxWaitMs: 0 });
      assertEquals(taker.fence, 2);
      await taker.release();
    },
  ],
  [
    "release marks the fence released, and inspect reports it",
    async (store, clock) => {
      const { writer } = writers(store, clock);
      const lease = writer().lease;
      assertEquals(await lease.inspect(), null);
      const hold = await lease.acquire({ maxWaitMs: 0 });
      const held = await lease.inspect();
      assertEquals(held?.state, "held");
      assertEquals(held?.fence, 1);
      assertEquals(held?.record?.nonce, hold.record.nonce);
      await hold.release();
      assertEquals((await lease.inspect())?.state, "released");
      // A released fence is never reused.
      const next = await lease.acquire({ maxWaitMs: 0 });
      assertEquals(next.fence, 2);
      await next.release();
    },
  ],
  [
    "a force release needs the current nonce, and fences the holder",
    async (store, clock) => {
      const { writer } = writers(store, clock);
      const holder = writer().lease;
      const hold = await holder.acquire({ maxWaitMs: 0 });
      const other = writer().lease;
      assertEquals(await other.forceRelease("stale-nonce"), false);
      assertEquals(await other.forceRelease(hold.record.nonce), true);
      assertEquals(await hold.renew(), "fenced");
      const next = await other.acquire({ maxWaitMs: 0 });
      assertEquals(next.fence, 2);
      await next.release();
    },
  ],
  [
    "a fence record left half-written by a crashed holder is taken over at once, while a live unknown holder is not",
    async (store, clock) => {
      const { writer } = writers(store, clock);
      await store.putIfAbsent(
        "writer/fence-000000000001",
        new TextEncoder().encode('{"fence":1,"hol'),
      );
      const taker = await writer().lease.acquire({ maxWaitMs: 0 });
      assertEquals(taker.fence, 2);
      await taker.release();

      // An unreadable record whose holder has renewed keeps writers out.
      await store.putIfAbsent(
        "writer/fence-000000000003",
        new TextEncoder().encode("not json"),
      );
      await store.put(
        "writer/heartbeat-000000000003",
        new TextEncoder().encode(JSON.stringify({
          fence: 3,
          nonce: "unknown",
          renewedAt: new Date(clock.now).toISOString(),
        })),
      );
      await assertRejects(
        () => writer().lease.acquire({ maxWaitMs: 0 }),
        WriterLeaseBusyError,
      );
      clock.advance(TTL + WRITER_LEASE_CLOCK_SKEW_MS + 1);
      const later = await writer().lease.acquire({ maxWaitMs: 0 });
      assertEquals(later.fence, 4);
      await later.release();
    },
  ],
  [
    "a take whose first renewal fails gives the fence up",
    async (store, clock) => {
      let failPut = true;
      const flaky: WriterLeaseStore = {
        put: (key, data) => {
          if (failPut) {
            failPut = false;
            return Promise.reject(new Error("disk full"));
          }
          return store.put(key, data);
        },
        get: (key, options) => store.get(key, options),
        delete: (key) => store.delete(key),
        list: (prefix) => store.list(prefix),
        putIfAbsent: (key, data) => store.putIfAbsent(key, data),
      };
      const { writer } = writers(flaky, clock, "host-a");
      await assertRejects(
        () => writer().lease.acquire({ maxWaitMs: 0 }),
        Error,
        "disk full",
      );
      // Released at once, not held until it expires.
      const { writer: next } = writers(store, clock, "host-b");
      const hold = await next().lease.acquire({ maxWaitMs: 0 });
      assertEquals(hold.fence, 2);
      await hold.release();
    },
  ],
  [
    "the next fence is above a floor the commit store gives",
    async (store, clock) => {
      const { writer } = writers(store, clock);
      const hold = await writer().lease.acquire({ maxWaitMs: 0, floor: 41 });
      assertEquals(hold.fence, 42);
      await hold.release();
    },
  ],
  [
    "a takeover prunes all but the previous fence's records",
    async (store, clock) => {
      const { writer } = writers(store, clock);
      for (let i = 0; i < 4; i++) {
        const hold = await writer().lease.acquire({ maxWaitMs: 0 });
        await hold.release();
      }
      const keys = (await store.list("writer/")).sort();
      assertEquals(keys, [
        "writer/fence-000000000003",
        "writer/fence-000000000004",
        "writer/released-000000000003",
        "writer/released-000000000004",
      ]);
    },
  ],
  [
    "an out-of-range stray fence key is ignored",
    async (store, clock) => {
      await store.put("writer/fence-1000000000000", STRAY);
      const { writer } = writers(store, clock);
      const first = await writer().lease.acquire({ maxWaitMs: 0 });
      assertEquals(first.fence, 1);
      const other = writer().lease;
      assertEquals((await other.inspect())?.fence, 1);
      assertEquals(await other.forceRelease(first.record.nonce), true);
      assertEquals((await other.inspect())?.state, "released");
      const second = await other.acquire({ maxWaitMs: 0 });
      assertEquals(second.fence, 2);
      await second.release();
    },
  ],
  [
    "an unpadded stray fence key neither counts nor blocks the real one",
    async (store, clock) => {
      await store.put("writer/fence-5", STRAY);
      const { writer } = writers(store, clock);
      assertEquals(await writer().lease.inspect(), null);
      for (let fence = 1; fence <= 5; fence++) {
        const hold = await writer().lease.acquire({ maxWaitMs: 0 });
        assertEquals(hold.fence, fence);
        await hold.release();
      }
      assert(
        (await store.list("writer/")).includes("writer/fence-000000000005"),
      );
    },
  ],
  [
    "unpadded stray heartbeat and released keys do not touch the holder",
    async (store, clock) => {
      const { writer } = writers(store, clock);
      const hold = await writer().lease.acquire({ maxWaitMs: 0 });
      await store.put("writer/released-1", STRAY);
      assertEquals(await hold.renew(), "held");
      // A stray renewal does not keep an expired holder in.
      clock.advance(TTL + WRITER_LEASE_CLOCK_SKEW_MS + 1);
      await store.put(
        "writer/heartbeat-1",
        new TextEncoder().encode(
          JSON.stringify({
            fence: 1,
            renewedAt: new Date(clock.now).toISOString(),
            nonce: hold.record.nonce,
          }),
        ),
      );
      const taker = await writer().lease.acquire({ maxWaitMs: 0 });
      assertEquals(taker.fence, 2);
      await taker.release();
    },
  ],
];

for (const [storeName, open] of STORES) {
  for (const [name, run] of CASES) {
    Deno.test(`WriterLease [${storeName}]: ${name}`, async () => {
      const { store, close } = await open();
      try {
        await run(store, new Clock());
      } finally {
        await close();
      }
    });
  }
}
