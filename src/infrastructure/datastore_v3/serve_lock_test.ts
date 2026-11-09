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
  closeServeLockClients,
  createServeLock,
  ServeLeaseLapsedError,
  ServeLock,
  type ServeLockClient,
} from "./serve_lock.ts";
import {
  registerServeUpstream,
  resetServeUpstreamBindingsForTesting,
} from "./serve_upstream_registry.ts";
import { ServeUpstreamTarget } from "../../domain/datastore_v3/serve_upstream.ts";
import {
  ServeLeaseLapsedRequestError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";
import {
  clearServeUnreachableLatches,
  ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import {
  heldServeLeaseOf,
  noteServeLeaseReleased,
  quietServeLeaseForRelease,
  resetServeLeasesForTesting,
  resumeServeLease,
  serveLeaseReleasedByCommit,
} from "./serve_lease_registry.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { ModelType } from "../../domain/models/model_type.ts";

await initializeLogging({});

const KEY = "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock";

class FakeServe implements ServeLockClient {
  readonly baseUrl = "https://serve.test";
  readonly timeoutMs = 30_000;
  readonly calls: string[] = [];
  answers: Array<"held" | "acquired" | Error> = ["acquired"];
  renewal: "renew" | "expired" | Error = "renew";
  /** renewals left that never answer until their signal aborts */
  hangingRenewals = 0;
  releaseError: Error | undefined;
  closed = 0;
  fence: number | undefined;
  floor: LockLease["floor"];
  #leases = 0;

  /** what a held answer says of its holder */
  heldReply: { heldBy?: string; holder?: unknown } = {};
  readonly budgets: (number | undefined)[] = [];

  acquireLock(
    lockKey: string,
    ttlMs: number,
    waitMs: number,
    _signal?: AbortSignal,
    options: { readonly budgetMs?: number } = {},
  ): Promise<LockAcquireReply> {
    this.calls.push(`acquire ${lockKey} ttl=${ttlMs} wait=${waitMs}`);
    this.budgets.push(options.budgetMs);
    const answer = this.answers.length > 1
      ? this.answers.shift()!
      : this.answers[0];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === "held") {
      return Promise.resolve({
        acquired: false,
        heldBy: "other",
        message: "held",
        ...this.heldReply,
      } as LockAcquireReply);
    }
    return Promise.resolve({ acquired: true, lease: this.#lease(ttlMs) });
  }

  renewLock(
    leaseId: string,
    ttlMs: number,
    signal?: AbortSignal,
  ): Promise<LockLease | undefined> {
    this.calls.push(`renew ${leaseId}`);
    if (this.hangingRenewals > 0) {
      this.hangingRenewals--;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }
    if (this.renewal instanceof Error) return Promise.reject(this.renewal);
    return Promise.resolve(
      this.renewal === "expired"
        ? undefined
        : { ...this.#lease(ttlMs), leaseId },
    );
  }

  /** a release that never answers until its signal aborts */
  hangingRelease = false;

  releaseLock(leaseId: string, signal?: AbortSignal): Promise<boolean> {
    this.calls.push(`release ${leaseId}`);
    if (this.hangingRelease) {
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }
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
  // the command's next request to serve fails as the lapse, unsent
  try {
    const next = new ServeDatastoreClient({
      baseUrl: serve.baseUrl,
      fetch: () => Promise.reject(new Error("never sent")),
    });
    const error = await assertRejects(
      () => next.changes(0, new AbortController().signal),
      ServeLeaseLapsedRequestError,
    );
    assertEquals(error.sent, "never");
  } finally {
    clearServeUnreachableLatches();
  }
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

Deno.test("ServeLock: offline, a recorded explicit lease is adopted on the local lock without asking serve, and registered (swamp-club#4195)", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  const events: string[] = [];
  const now = Date.parse("2026-10-30T10:00:00.000Z");
  const explicit = {
    leaseId: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a56",
    lockKey: KEY,
    fence: 11,
    holdMs: 3_600_000,
    expiresAt: new Date(now + 3_600_000).toISOString(),
    floor: [{ name: "vpc", highWater: 2 }],
  };
  const subject = lock(serve, {
    root: ROOT,
    now: () => now,
    adopt: () => Promise.resolve(explicit),
    localLock: () => localLock(events),
    offline: () => ({ skewMs: 10_000 }),
  });
  await subject.acquire();
  assertEquals(serve.calls, []);
  assertEquals(subject.lease?.fence, 11);
  assertEquals(heldServeLeaseOf(ROOT, PARTITION)?.leaseId, explicit.leaseId);
  await subject.release();
  assertEquals(serve.calls, []);
  assertEquals(events, ["local acquire", "local release"]);
});

Deno.test("ServeLock: offline, a lease past its end by serve's clock, or none, holds the local lock only (swamp-club#4195)", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  const events: string[] = [];
  const now = Date.parse("2026-10-30T10:00:00.000Z");
  const explicit = {
    leaseId: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a57",
    lockKey: KEY,
    fence: 12,
    holdMs: 3_600_000,
    // Live by this clock, not by serve's, which runs a minute ahead.
    expiresAt: new Date(now + 30_000).toISOString(),
    floor: [],
  };
  const subject = lock(serve, {
    root: ROOT,
    now: () => now,
    adopt: () => Promise.resolve(explicit),
    localLock: () => localLock(events),
    offline: () => ({ clockOffsetMs: 60_000, skewMs: 10_000 }),
  });
  await subject.acquire();
  assertEquals(subject.lease, undefined);
  assertEquals(heldServeLeaseOf(ROOT, PARTITION), undefined);
  await subject.release();
  assertEquals(serve.calls, []);
  assertEquals(events, ["local acquire", "local release"]);
});

Deno.test("ServeLock: offline, the work under an adopted lease is cancelled when its recorded end passes (swamp-club#4195)", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  let lost: ServeLeaseLapsedError | undefined;
  const subject = lock(serve, {
    root: ROOT,
    adopt: () =>
      Promise.resolve({
        leaseId: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a58",
        lockKey: KEY,
        fence: 13,
        holdMs: 3_600_000,
        expiresAt: new Date(Date.now() + 10_050).toISOString(),
        floor: [],
      }),
    localLock: () => localLock([]),
    offline: () => ({ skewMs: 10_000 }),
    onLost: (error) => lost = error,
  });
  await subject.acquire();
  await waitFor(() => lost !== undefined, "the offline lease to run out");
  assertInstanceOf(lost, ServeLeaseLapsedError);
  assertEquals(heldServeLeaseOf(ROOT, PARTITION), undefined);
  await subject.release();
});

Deno.test("ServeLock.acquire: an abort between asks stops the wait with its reason and holds no lease", async () => {
  const serve = new FakeServe();
  serve.answers = ["held"];
  const abort = new AbortController();
  const asked = serve.acquireLock.bind(serve);
  serve.acquireLock = (lockKey, ttlMs, waitMs) => {
    const reply = asked(lockKey, ttlMs, waitMs);
    abort.abort(new Error("run cancelled"));
    return reply;
  };
  const subject = lock(serve, { requestWaitMs: 0, maxWaitMs: 60_000 });
  await assertRejects(
    () => subject.acquire(abort.signal),
    Error,
    "run cancelled",
  );
  assertEquals(
    serve.calls.filter((call) => call.startsWith("acquire")).length,
    1,
  );
  assertEquals(subject.lease, undefined);
  assertEquals(serve.closed, 1);
});

Deno.test("ServeLock: a renewal that never answers is abandoned at its deadline, so the next one is sent and the lease holds", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.fence = 2;
  serve.hangingRenewals = 1;
  const lost: Error[] = [];
  const subject = lock(serve, {
    root: ROOT,
    ttlMs: 300,
    onLost: (error) => lost.push(error),
  });
  await subject.acquire();
  try {
    await waitFor(
      () => serve.calls.filter((call) => call.startsWith("renew")).length >= 3,
      "renewals after the stalled one",
      { timeoutMs: 5_000 },
    );
    assertEquals(lost, []);
  } finally {
    await subject.release();
  }
});

Deno.test("ServeLock: every lock a long run takes closes the client it opened, so connections never pile up", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.fence = 2;
  let made = 0;
  const cycles = 50;
  for (let i = 0; i < cycles; i++) {
    const subject = lock(serve, {
      root: ROOT,
      client: () => {
        made++;
        return serve;
      },
    });
    await subject.acquire();
    await subject.release();
  }
  assertEquals(made, cycles);
  assertEquals(serve.closed, cycles);
});

Deno.test("ServeLock.release: a release serve never answers is given up at its deadline, and the client is still closed", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.hangingRelease = true;
  const subject = lock(serve);
  await subject.acquire();
  await subject.release();
  assertEquals(serve.closed, 1);
});

const IN_TEN_MINUTES = () => new Date(Date.now() + 600_000).toISOString();

Deno.test("ServeLock.acquire: another principal's explicit lease that outlasts the wait is refused after one ask, naming who holds it and until when", async () => {
  const serve = new FakeServe();
  serve.answers = ["held"];
  const until = IN_TEN_MINUTES();
  serve.heldReply = {
    holder: { principal: "user:boss", explicit: true, expiresAt: until },
  };
  const subject = lock(serve, { maxWaitMs: 60_000 });
  const error = await assertRejects(() => subject.acquire(), LockTimeoutError);
  assertEquals(serve.calls.length, 1);
  assertStringIncludes(error.message, "user:boss");
  assertStringIncludes(error.message, "explicit lease");
  assertStringIncludes(error.message, until);
  assertEquals(error.code, "lock_timeout");
});

Deno.test("ServeLock.acquire: this caller's explicit lease held from another checkout is refused at once too", async () => {
  const serve = new FakeServe();
  serve.answers = ["held"];
  serve.heldReply = {
    heldBy: "caller",
    holder: {
      principal: "user:m1",
      explicit: true,
      expiresAt: IN_TEN_MINUTES(),
    },
  };
  const subject = lock(serve, { maxWaitMs: 60_000 });
  await assertRejects(() => subject.acquire(), LockTimeoutError);
  assertEquals(serve.calls.length, 1);
});

Deno.test("ServeLock.acquire: a run lease that renews is waited out, whatever its expiry says", async () => {
  const serve = new FakeServe();
  serve.answers = ["held", "held", "acquired"];
  serve.heldReply = {
    holder: {
      principal: "user:boss",
      explicit: false,
      expiresAt: IN_TEN_MINUTES(),
    },
  };
  const subject = lock(serve, { maxWaitMs: 60_000 });
  await subject.acquire();
  await subject.release();
  assertEquals(
    serve.calls.filter((call) => call.startsWith("acquire")).length,
    3,
  );
});

Deno.test("ServeLock.acquire: each ask tells serve what is left of the whole wait", async () => {
  const serve = new FakeServe();
  const subject = lock(serve, { maxWaitMs: 60_000 });
  await subject.acquire();
  await subject.release();
  const budget = serve.budgets[0];
  assert(budget !== undefined && budget > 50_000 && budget <= 60_000);
});

/**
 * a serve whose answers the test holds back: `stall` names the lock keys whose
 * acquire, and the lease ids whose renewal, wait until `go` is called
 */
function stallingServe(stall: { acquire?: string; renew?: string }) {
  const answered: string[] = [];
  const remotePorts = new Set<number>();
  let go!: () => void;
  const released = new Promise<void>((resolve) => go = resolve);
  const lease = (leaseId: string, lockKey: string, ttlMs: number) => ({
    leaseId,
    lockKey,
    ttlMs,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    fence: 1,
  });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request, info) => {
      remotePorts.add((info.remoteAddr as Deno.NetAddr).port);
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path.endsWith("/locks")) {
        const body = await request.json() as {
          lockKey: string;
          ttlMs: number;
        };
        if (body.lockKey === stall.acquire) await released;
        answered.push(`acquire:${body.lockKey}`);
        return Response.json(
          lease(`lease-${body.lockKey}`, body.lockKey, body.ttlMs),
          { status: 201 },
        );
      }
      const leaseId = decodeURIComponent(path.split("/").pop() ?? "");
      if (request.method === "PUT") {
        const body = await request.json() as { ttlMs: number };
        if (leaseId === stall.renew) await released;
        answered.push(`renew:${leaseId}`);
        return Response.json(lease(leaseId, leaseId, body.ttlMs));
      }
      if (request.method === "DELETE") {
        answered.push(`release:${leaseId}`);
        return Response.json({ released: true });
      }
      return new Response("no", { status: 404 });
    },
  );
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    answered,
    remotePorts,
    go: () => go(),
    close: async () => {
      go();
      await server.shutdown();
    },
  };
}

async function withLockBinding(
  origin: string,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "swamp-serve-lock-" });
  registerServeUpstream({
    root,
    target: ServeUpstreamTarget.create({ serverUrl: origin }),
    namespace: "_default",
    client: () => {
      throw new Error("a lock uses its own client");
    },
  });
  try {
    await fn(root);
  } finally {
    closeServeLockClients();
    resetServeUpstreamBindingsForTesting();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

Deno.test("createServeLock: a lock waiting long at serve never holds up another lock's renewal on the shared client", async () => {
  const serve = stallingServe({ acquire: "a/.lock" });
  try {
    await withLockBinding(serve.origin, async (root) => {
      const b = createServeLock(root, {
        lockKey: "b/.lock",
        maxWaitMs: 5_000,
        ttlMs: 300,
      })!;
      await b.acquire();
      const a = createServeLock(root, {
        lockKey: "a/.lock",
        maxWaitMs: 5_000,
      })!;
      const waiting = a.acquire();
      await waitFor(
        () => serve.answered.includes("renew:lease-b/.lock"),
        "b's renewal answered while a waits",
      );
      assertEquals(serve.answered.includes("acquire:a/.lock"), false);
      serve.go();
      await waiting;
      await a.release();
      await b.release();
    });
  } finally {
    await serve.close();
  }
});

Deno.test("createServeLock: a lock's stalled renewal never holds up another lock's renewal on the shared client", async () => {
  const serve = stallingServe({ renew: "lease-a/.lock" });
  try {
    await withLockBinding(serve.origin, async (root) => {
      const a = createServeLock(root, {
        lockKey: "a/.lock",
        maxWaitMs: 5_000,
        ttlMs: 300,
      })!;
      const b = createServeLock(root, {
        lockKey: "b/.lock",
        maxWaitMs: 5_000,
        ttlMs: 300,
      })!;
      await a.acquire();
      await b.acquire();
      await waitFor(
        () => serve.answered.includes("renew:lease-b/.lock"),
        "b's renewal answered while a's stalls",
      );
      assertEquals(serve.answered.includes("renew:lease-a/.lock"), false);
      serve.go();
      await a.release();
      await b.release();
    });
  } finally {
    await serve.close();
  }
});

Deno.test("createServeLock: a command's locks one after another reuse one kept connection", async () => {
  const serve = stallingServe({});
  try {
    await withLockBinding(serve.origin, async (root) => {
      for (const key of ["a/.lock", "b/.lock", "c/.lock"]) {
        const lock = createServeLock(root, { lockKey: key, maxWaitMs: 5_000 })!;
        await lock.acquire();
        await lock.release();
      }
      assertEquals(serve.remotePorts.size, 1);
    });
  } finally {
    await serve.close();
  }
});

Deno.test("ServeLock.release: a lease the closing commit ended is not released again, and the quieted hold never renews or lapses", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  serve.fence = 1;
  // a renewal answered after serve ended the lease reads as expired
  serve.renewal = "expired";
  const lost: Error[] = [];
  const subject = lock(serve, {
    ttlMs: 30,
    root: "/tmp/swamp-lock-release-test",
    onLost: (error) => lost.push(error),
  });
  try {
    await subject.acquire();
    const leaseId = subject.lease!.leaseId;
    assertEquals(await quietServeLeaseForRelease(leaseId), true);
    noteServeLeaseReleased(leaseId);
    const renewals = serve.calls.filter((call) => call.startsWith("renew"));
    // longer than the lease and its renewal interval
    await new Promise((resolve) => setTimeout(resolve, 80));
    assertEquals(
      serve.calls.filter((call) => call.startsWith("renew")),
      renewals,
      "no renewal once quieted",
    );
    await subject.release();
    assertEquals(lost, []);
    assertEquals(
      serve.calls.filter((call) => call.startsWith("release")),
      [],
      "serve already ended it",
    );
    assertEquals(serveLeaseReleasedByCommit(leaseId), false, "withdrawn");
  } finally {
    resetServeLeasesForTesting();
  }
});

Deno.test("ServeLock.release: a lease the closing commit did not end is released as before", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  const subject = lock(serve);
  try {
    await subject.acquire();
    const leaseId = subject.lease!.leaseId;
    assertEquals(await quietServeLeaseForRelease(leaseId), true);
    await subject.release();
    assertEquals(
      serve.calls.filter((call) => call.startsWith("release")),
      [`release ${leaseId}`],
    );
  } finally {
    resetServeLeasesForTesting();
  }
});

Deno.test("ServeLock: a hold quieted for a release serve did not make renews again", async () => {
  resetServeLeasesForTesting();
  const serve = new FakeServe();
  const subject = lock(serve, { ttlMs: 30 });
  try {
    await subject.acquire();
    const leaseId = subject.lease!.leaseId;
    await quietServeLeaseForRelease(leaseId);
    const quieted = serve.calls.filter((c) => c.startsWith("renew")).length;
    resumeServeLease(leaseId);
    await waitFor(
      () => serve.calls.filter((c) => c.startsWith("renew")).length > quieted,
      "a renewal after the resume",
    );
    await subject.release();
    assertEquals(
      serve.calls.filter((c) => c.startsWith("release")),
      [`release ${leaseId}`],
    );
  } finally {
    resetServeLeasesForTesting();
  }
});
