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
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { initializeLogging } from "../logging/logger.ts";
import type { LockAcquireReply, LockLease } from "./serve_datastore_client.ts";
import {
  ServeLeaseLapsedError,
  ServeLock,
  type ServeLockClient,
} from "./serve_lock.ts";
import {
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";
import {
  heldServeLeaseOf,
  resetServeLeasesForTesting,
} from "./serve_lease_registry.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { ModelType } from "../../domain/models/model_type.ts";

await initializeLogging({});

const KEY = "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock";

/** Serve's lock routes, in memory, recording every call. */
class FakeServe implements ServeLockClient {
  readonly baseUrl = "https://serve.test";
  readonly timeoutMs = 30_000;
  readonly calls: string[] = [];
  /** Answers each acquire in turn; the last repeats. */
  answers: Array<"held" | "acquired" | Error> = ["acquired"];
  /** The lease renewals answer with; undefined says it expired. */
  renewal: "renew" | "expired" | Error = "renew";
  releaseError: Error | undefined;
  closed = 0;
  /** The fence each granted lease carries; undefined is an older serve. */
  fence: number | undefined;
  floor: LockLease["floor"];
  #leases = 0;

  acquireLock(
    lockKey: string,
    ttlMs: number,
    waitMs: number,
  ): Promise<LockAcquireReply> {
    this.calls.push(`acquire ${lockKey} ttl=${ttlMs} wait=${waitMs}`);
    const answer = this.answers.length > 1
      ? this.answers.shift()!
      : this.answers[0];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === "held") {
      return Promise.resolve({
        acquired: false,
        heldBy: "other",
        message: "held",
      });
    }
    return Promise.resolve({ acquired: true, lease: this.#lease(ttlMs) });
  }

  renewLock(leaseId: string, ttlMs: number): Promise<LockLease | undefined> {
    this.calls.push(`renew ${leaseId}`);
    if (this.renewal instanceof Error) return Promise.reject(this.renewal);
    return Promise.resolve(
      this.renewal === "expired"
        ? undefined
        : { ...this.#lease(ttlMs), leaseId },
    );
  }

  releaseLock(leaseId: string): Promise<boolean> {
    this.calls.push(`release ${leaseId}`);
    if (this.releaseError !== undefined) {
      return Promise.reject(this.releaseError);
    }
    return Promise.resolve(true);
  }

  close(): void {
    this.closed++;
  }

  #lease(ttlMs: number): LockLease {
    return {
      leaseId: `lease-${++this.#leases}`,
      lockKey: KEY,
      ttlMs,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      ...(this.fence === undefined ? {} : { fence: this.fence }),
      ...(this.floor === undefined ? {} : { floor: this.floor }),
    };
  }
}

function lock(
  serve: FakeServe,
  options: Partial<ConstructorParameters<typeof ServeLock>[0]> = {},
): ServeLock {
  return new ServeLock({
    client: () => serve,
    lockKey: KEY,
    maxWaitMs: 5_000,
    retryIntervalMs: 1,
    ...options,
  });
}

Deno.test("ServeLock.acquire: takes a lease at serve, catches up, and releases it once", async () => {
  const serve = new FakeServe();
  const order: string[] = [];
  const subject = lock(serve, {
    onAcquired: () => {
      order.push(`caught up after ${serve.calls.length} call(s)`);
      return Promise.resolve();
    },
  });
  await subject.acquire();
  assertEquals(subject.lease?.leaseId, "lease-1");
  assertEquals(order, ["caught up after 1 call(s)"]);
  const info = await subject.inspect();
  assertEquals(info?.nonce, "lease-1");
  assertEquals(info?.hostname, "serve.test");
  await subject.release();
  await subject.release();
  assertEquals(
    serve.calls.filter((call) => call.startsWith("release")),
    ["release lease-1"],
  );
  assertEquals(serve.closed, 1);
  assertEquals(await subject.inspect(), null);
  assertEquals(await subject.forceRelease("lease-1"), false);
});

Deno.test("ServeLock.acquire: asks again while the lock is held, then takes it", async () => {
  const serve = new FakeServe();
  serve.answers = ["held", "held", "acquired"];
  const subject = lock(serve, { requestWaitMs: 0 });
  await subject.acquire();
  try {
    assertEquals(
      serve.calls.filter((call) => call.startsWith("acquire")).length,
      3,
    );
  } finally {
    await subject.release();
  }
});

Deno.test("ServeLock.acquire: still held after maxWaitMs is a LockTimeoutError naming no other principal", async () => {
  const serve = new FakeServe();
  serve.answers = ["held"];
  const subject = lock(serve, { maxWaitMs: 30, displayKey: "ns/" + KEY });
  const error = await assertRejects(() => subject.acquire(), LockTimeoutError);
  assertEquals(error.lockKey, "ns/" + KEY);
  assertStringIncludes(
    error.message,
    "held at serve serve.test by another caller",
  );
  assertEquals(serve.closed, 1);
  assertEquals(subject.lease, undefined);
});

Deno.test("ServeLock.acquire: each request asks serve to wait within the request timeout and the time left", async () => {
  const serve = new FakeServe();
  const subject = lock(serve, { maxWaitMs: 60_000 });
  await subject.acquire();
  await subject.release();
  // Ten seconds at most per request, below half the 30s request timeout.
  assertStringIncludes(serve.calls[0], "wait=10000");
  assertStringIncludes(serve.calls[0], "ttl=30000");
});

Deno.test("ServeLock.acquire: serve unreachable is thrown as it is, so the command exits 75", async () => {
  const serve = new FakeServe();
  serve.answers = [
    new ServeUnreachableError(serve.baseUrl, "never", new Error("refused")),
  ];
  const subject = lock(serve);
  await assertRejects(() => subject.acquire(), ServeUnreachableError);
  assertEquals(serve.closed, 1);
});

Deno.test("ServeLock.acquire: a catch-up that fails releases the lease and rejects", async () => {
  const serve = new FakeServe();
  const subject = lock(serve, {
    onAcquired: () => Promise.reject(new Error("catch-up failed")),
  });
  const error = await assertRejects(() => subject.acquire());
  assertInstanceOf(error, Error);
  assertEquals(error.message, "catch-up failed");
  assert(serve.calls.includes("release lease-1"));
  assertEquals(subject.lease, undefined);
});

Deno.test("ServeLock: renews the lease at a third of its TTL while held", async () => {
  const serve = new FakeServe();
  const subject = lock(serve, { ttlMs: 30 });
  await subject.acquire();
  try {
    await waitFor(
      () => serve.calls.filter((call) => call.startsWith("renew")).length >= 2,
      "two renewals",
    );
  } finally {
    await subject.release();
  }
});

Deno.test("ServeLock: a lease serve says expired stops renewing; release still ends the hold", async () => {
  const serve = new FakeServe();
  serve.renewal = "expired";
  const subject = lock(serve, { ttlMs: 30 });
  await subject.acquire();
  await waitFor(
    () => serve.calls.some((call) => call.startsWith("renew")),
    "a renewal",
  );
  const renewals = serve.calls.filter((call) => call.startsWith("renew"))
    .length;
  await subject.release();
  assertEquals(
    serve.calls.filter((call) => call.startsWith("renew")).length,
    renewals,
  );
  assertEquals(serve.closed, 1);
});

Deno.test("ServeLock.release: a release serve cannot be told of is left to the lease's TTL", async () => {
  const serve = new FakeServe();
  serve.releaseError = new ServeUnreachableError(
    serve.baseUrl,
    "never",
    new Error("refused"),
  );
  const subject = lock(serve);
  await subject.acquire();
  await subject.release();
  assertEquals(subject.lease, undefined);
  assertEquals(serve.closed, 1);
});

Deno.test("ServeLock.withLock: holds the lease for the callback only", async () => {
  const serve = new FakeServe();
  const subject = lock(serve);
  const inside = await subject.withLock(() =>
    Promise.resolve(subject.lease?.leaseId)
  );
  assertEquals(inside, "lease-1");
  assertEquals(subject.lease, undefined);
  assert(serve.calls.includes("release lease-1"));
});

// Fenced leases (swamp-club#4121).

const ROOT = "/checkout/.swamp/datastore";
const PARTITION = partitionOf({
  kind: "model",
  type: ModelType.create("aws/ec2"),
  id: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01",
});

Deno.test("ServeLock: a fenced lease is registered once acquire succeeds, and released from the registry", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.fence = 4;
  serve.floor = [{ name: "vpc", highWater: 9 }];
  let seenDuringCatchUp: unknown = "unset";
  const subject = lock(serve, {
    root: ROOT,
    onAcquired: () => {
      seenDuringCatchUp = heldServeLeaseOf(ROOT, PARTITION);
      return Promise.resolve();
    },
  });
  await subject.acquire();
  // Not before acquire succeeded.
  assertEquals(seenDuringCatchUp, undefined);
  assertEquals(heldServeLeaseOf(ROOT, PARTITION), {
    leaseId: "lease-1",
    fence: 4,
    floor: [{ name: "vpc", highWater: 9 }],
  });
  await subject.release();
  assertEquals(heldServeLeaseOf(ROOT, PARTITION), undefined);
});

Deno.test("ServeLock: a failed catch-up registers nothing", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.fence = 1;
  const subject = lock(serve, {
    root: ROOT,
    onAcquired: () => Promise.reject(new Error("catch-up failed")),
  });
  await assertRejects(() => subject.acquire(), Error, "catch-up failed");
  assertEquals(heldServeLeaseOf(ROOT, PARTITION), undefined);
});

Deno.test("ServeLock: an unfenced lease (an older serve) is not registered, and its expiry only stops renewing", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.renewal = "expired";
  const lost: Error[] = [];
  const subject = lock(serve, {
    root: ROOT,
    ttlMs: 30,
    onLost: (error) => lost.push(error),
  });
  await subject.acquire();
  assertEquals(heldServeLeaseOf(ROOT, PARTITION), undefined);
  await waitFor(
    () => serve.calls.some((call) => call.startsWith("renew")),
    "a renewal",
  );
  await subject.release();
  assertEquals(lost, []);
});

for (
  const [label, renewal] of [
    ["serve says it expired", "expired"],
    [
      "serve refuses the renewal",
      new ServeUpstreamError(403, "forbidden", "run was revoked"),
    ],
  ] as const
) {
  Deno.test(`ServeLock: a fenced lease lapses once when ${label}, and leaves the registry`, async () => {
    resetServeLeasesForTesting();
    const serve = new FakeServe();
    serve.fence = 2;
    serve.renewal = renewal;
    const lost: ServeLeaseLapsedError[] = [];
    const subject = lock(serve, {
      root: ROOT,
      ttlMs: 30,
      onLost: (error) => lost.push(error),
    });
    await subject.acquire();
    await waitFor(() => lost.length > 0, "the lapse");
    assertEquals(lost.length, 1);
    assertInstanceOf(lost[0], ServeLeaseLapsedError);
    assertStringIncludes(lost[0].message, KEY);
    assertEquals(heldServeLeaseOf(ROOT, PARTITION), undefined);
    await subject.release();
    assertEquals(lost.length, 1);
  });
}

Deno.test("ServeLock: a fenced lease that cannot be renewed before its local deadline lapses, by the local clock", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.fence = 2;
  // Serve away: every renewal fails as unreachable.
  serve.renewal = new ServeUnreachableError(
    "https://serve.test",
    "maybe",
    new Error("connection refused"),
  );
  let monotonic = 0;
  const lost: Error[] = [];
  const subject = lock(serve, {
    root: ROOT,
    ttlMs: 60,
    // Serve's wall clock is far off; only the local monotonic one counts.
    now: () => Date.now() + 3_600_000,
    monotonic: () => monotonic,
    onLost: (error) => lost.push(error),
  });
  await subject.acquire();
  monotonic = 1_000;
  await waitFor(() => lost.length > 0, "the lapse");
  assertStringIncludes(lost[0].message, "could not be renewed in time");
  assertEquals(heldServeLeaseOf(ROOT, PARTITION), undefined);
  await subject.release();
});

Deno.test("ServeLock: a renewed fenced lease keeps its fence and floor", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.fence = 5;
  serve.floor = [{ name: "vpc", highWater: 1 }];
  const subject = lock(serve, { root: ROOT, ttlMs: 30 });
  await subject.acquire();
  serve.fence = undefined;
  serve.floor = undefined;
  await waitFor(
    () => serve.calls.filter((call) => call.startsWith("renew")).length >= 2,
    "two renewals",
  );
  assertEquals(subject.lease?.fence, 5);
  assertEquals(subject.lease?.floor, [{ name: "vpc", highWater: 1 }]);
  await subject.release();
});

/** A checkout-local lock, recording when it is held. */
function localLock(events: string[]) {
  return {
    acquire: () => {
      events.push("local acquire");
      return Promise.resolve();
    },
    release: () => {
      events.push("local release");
      return Promise.resolve();
    },
    withLock: <T>(fn: () => Promise<T>) => fn(),
    inspect: () => Promise.resolve(null),
    forceRelease: () => Promise.resolve(false),
  };
}

Deno.test("ServeLock: a recorded explicit lease is adopted, renewed for its hold, registered, and left held at release", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  const events: string[] = [];
  const explicit = {
    leaseId: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a55",
    lockKey: KEY,
    fence: 9,
    holdMs: 1_800_000,
    expiresAt: "2026-10-29T12:30:00.000Z",
    floor: [{ name: "vpc", highWater: 4 }],
  };
  const subject = lock(serve, {
    root: ROOT,
    adopt: () => Promise.resolve(explicit),
    localLock: () => localLock(events),
  });
  await subject.acquire();
  assertEquals(serve.calls, [`renew ${explicit.leaseId}`]);
  assertEquals(heldServeLeaseOf(ROOT, PARTITION), {
    leaseId: explicit.leaseId,
    fence: 9,
    floor: explicit.floor,
  });
  await subject.release();
  // Never released at serve, and still registered: the lease outlives the
  // command, and the process's other commits still name it.
  assertEquals(serve.calls.filter((call) => call.startsWith("release")), []);
  assertEquals(heldServeLeaseOf(ROOT, PARTITION)?.leaseId, explicit.leaseId);
  assertEquals(events, ["local acquire", "local release"]);
});

Deno.test("ServeLock: a recorded explicit lease serve ended is forgotten, and the lock is taken as usual", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.renewal = "expired";
  serve.fence = 2;
  const events: string[] = [];
  const forgotten: string[] = [];
  const subject = lock(serve, {
    root: ROOT,
    adopt: () =>
      Promise.resolve({
        leaseId: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a56",
        lockKey: KEY,
        fence: 1,
        holdMs: 60_000,
        expiresAt: "2026-10-29T12:30:00.000Z",
        floor: [],
      }),
    forget: (leaseId) => {
      forgotten.push(leaseId);
      return Promise.resolve();
    },
    localLock: () => localLock(events),
  });
  await subject.acquire();
  assertEquals(forgotten, ["0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a56"]);
  assert(serve.calls.some((call) => call.startsWith("acquire")));
  assertEquals(events, ["local acquire", "local release"]);
  await subject.release();
  assert(serve.calls.includes("release lease-1"));
});
