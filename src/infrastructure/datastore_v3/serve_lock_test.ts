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
import { ServeLock, type ServeLockClient } from "./serve_lock.ts";
import { ServeUnreachableError } from "./serve_upstream_errors.ts";

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
