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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  asTryLock,
  DatastoreLockLeases,
  type DatastoreLockLeasesOptions,
  lockKeyOf,
  type LockTarget,
  parseLockKey,
  type TryLock,
} from "./datastore_locks.ts";

const ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01";
const RUN = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a02";

/**
 * Serve's own locks, in memory: a key is held by one lock instance at a
 * time, as a file lock is. `serveTakes` holds a key as serve's own work.
 */
function fakeLocks() {
  const held = new Map<string, object>();
  const releases: string[] = [];
  const createLock = (target: LockTarget): Promise<TryLock> => {
    const key = lockKeyOf(target);
    const self = {};
    return Promise.resolve({
      tryAcquire: () => {
        if (held.has(key)) return Promise.resolve(false);
        held.set(key, self);
        return Promise.resolve(true);
      },
      release: () => {
        if (held.get(key) === self) {
          held.delete(key);
          releases.push(key);
        }
        return Promise.resolve();
      },
    });
  };
  return {
    held,
    releases,
    createLock,
    serveTakes: (key: string) => held.set(key, { serve: true }),
  };
}

function leases(
  locks: ReturnType<typeof fakeLocks>,
  options: Partial<DatastoreLockLeasesOptions> = {},
): DatastoreLockLeases {
  return new DatastoreLockLeases({
    createLock: locks.createLock,
    minTtlMs: 10,
    retryIntervalMs: 5,
    ...options,
  });
}

const model: LockTarget = { kind: "model", modelType: "aws/ec2", modelId: ID };

function request(
  principal: string,
  overrides: Partial<{ ttlMs: number; waitMs: number; signal: AbortSignal }> =
    {},
) {
  return {
    principal,
    target: model,
    ttlMs: 60_000,
    waitMs: 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

Deno.test("parseLockKey: model and workflow-run keys parse to their canonical target", () => {
  assertEquals(parseLockKey(`data/aws/ec2/${ID}/.lock`), model);
  // The type is normalized and the id lowercased, so every spelling of one
  // behavior is one lock.
  assertEquals(
    parseLockKey(`data/AWS::EC2/${ID.toUpperCase()}/.lock`),
    model,
  );
  assertEquals(
    parseLockKey(`data/@hivemq/harvester-host/${ID}/.lock`),
    { kind: "model", modelType: "@hivemq/harvester-host", modelId: ID },
  );
  assertEquals(parseLockKey(`workflow-run-claims/${RUN}/.lock`), {
    kind: "workflow-run",
    runId: RUN,
  });
  assertEquals(lockKeyOf(model), `data/aws/ec2/${ID}/.lock`);
});

Deno.test("parseLockKey: anything else, and any key a path could escape with, is refused", () => {
  for (
    const key of [
      undefined,
      42,
      "",
      ".datastore.lock",
      `ns/data/aws/${ID}/.lock`,
      `data/aws/${ID}/lock`,
      `data/${ID}/.lock`,
      "data/aws/not-a-uuid/.lock",
      `data/a\\..\\..\\etc/${ID}/.lock`,
      `data/c:/x/${ID}/.lock`,
      `data/%2e%2e/${ID}/.lock`,
      `data/a\u0000b/${ID}/.lock`,
      `data/../../x/${ID}/.lock`,
      `workflow-run-claims/${RUN}/extra/.lock`,
      "workflow-run-claims/run-1/.lock",
      `data/${"a".repeat(600)}/${ID}/.lock`,
    ]
  ) {
    const parsed = parseLockKey(key);
    if (parsed !== undefined && parsed.kind === "model") {
      // ".." collapses to "/" in a normalized type: nothing escapes.
      assert(
        !lockKeyOf(parsed).split("/").includes(".."),
        `${key} escapes: ${lockKeyOf(parsed)}`,
      );
      continue;
    }
    assertEquals(parsed, undefined, String(key));
  }
});

Deno.test("DatastoreLockLeases.acquire: takes serve's lock, and a second caller is told only that another holds it", async () => {
  const locks = fakeLocks();
  const subject = leases(locks);
  try {
    const first = await subject.acquire(request("user:alice"));
    assert(first.kind === "acquired");
    assertEquals(first.lease.lockKey, lockKeyOf(model));
    assert(locks.held.has(lockKeyOf(model)));
    assertEquals(await subject.acquire(request("user:bob")), {
      kind: "held",
      heldBy: "other",
    });
    assertEquals(await subject.acquire(request("user:alice")), {
      kind: "held",
      heldBy: "caller",
    });
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.acquire: serve's own run holding the lock is reported as serve's", async () => {
  const locks = fakeLocks();
  locks.serveTakes(lockKeyOf(model));
  const subject = leases(locks);
  try {
    assertEquals(await subject.acquire(request("user:alice")), {
      kind: "held",
      heldBy: "serve",
    });
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.acquire: a waiting caller gets the lock once its holder releases", async () => {
  const locks = fakeLocks();
  const subject = leases(locks);
  try {
    const first = await subject.acquire(request("user:alice"));
    assert(first.kind === "acquired");
    const waiting = subject.acquire(request("user:bob", { waitMs: 5_000 }));
    assert(await subject.release("user:alice", first.lease.leaseId));
    const second = await waiting;
    assertEquals(second.kind, "acquired");
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.acquire: a lock taken for a caller that hung up is released again", async () => {
  const locks = fakeLocks();
  locks.serveTakes(lockKeyOf(model));
  const subject = leases(locks);
  try {
    const abort = new AbortController();
    const waiting = subject.acquire(
      request("user:alice", { waitMs: 5_000, signal: abort.signal }),
    );
    abort.abort();
    assertEquals((await waiting).kind, "held");
    assertEquals(subject.size, 0);
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases: a lease not renewed within its TTL is released, and renewing it then fails", async () => {
  const locks = fakeLocks();
  const subject = leases(locks);
  try {
    const taken = await subject.acquire(request("user:alice", { ttlMs: 20 }));
    assert(taken.kind === "acquired");
    await waitFor(
      () => locks.releases.includes(lockKeyOf(model)),
      "the expired lease's release",
    );
    assertEquals(subject.size, 0);
    assertEquals(
      subject.renew("user:alice", taken.lease.leaseId, 60_000),
      undefined,
    );
    assertEquals(
      await subject.release("user:alice", taken.lease.leaseId),
      false,
    );
    // Free for the next caller.
    assertEquals(
      (await subject.acquire(request("user:bob"))).kind,
      "acquired",
    );
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.renew: extends the lease, and only for the principal holding it", async () => {
  const locks = fakeLocks();
  let now = 1_000_000;
  const subject = leases(locks, { now: () => now });
  try {
    const taken = await subject.acquire(request("user:alice"));
    assert(taken.kind === "acquired");
    now += 30_000;
    assertEquals(
      subject.renew("user:bob", taken.lease.leaseId, 60_000),
      undefined,
    );
    const renewed = subject.renew("user:alice", taken.lease.leaseId, 90_000);
    assertEquals(renewed?.ttlMs, 90_000);
    assertEquals(renewed?.expiresAt, new Date(now + 90_000).toISOString());
    // Another principal cannot release it either.
    assertEquals(await subject.release("user:bob", taken.lease.leaseId), false);
    assert(locks.held.has(lockKeyOf(model)));
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.release: releases serve's lock once; a second release is false", async () => {
  const locks = fakeLocks();
  const subject = leases(locks);
  try {
    const taken = await subject.acquire(request("user:alice"));
    assert(taken.kind === "acquired");
    assert(await subject.release("user:alice", taken.lease.leaseId));
    assertEquals(locks.held.size, 0);
    assertEquals(
      await subject.release("user:alice", taken.lease.leaseId),
      false,
    );
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.acquire: a principal holds a bounded number of leases", async () => {
  const locks = fakeLocks();
  const subject = leases(locks, { maxLeasesPerPrincipal: 2 });
  try {
    const ids = [
      "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a11",
      "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a12",
      "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a13",
    ];
    const outcomes = await Promise.all(ids.map((modelId) =>
      subject.acquire({
        ...request("user:alice"),
        target: { kind: "model", modelType: "aws/ec2", modelId },
      })
    ));
    assertEquals(
      outcomes.map((outcome) => outcome.kind).sort(),
      ["acquired", "acquired", "too-many"],
    );
    // The refused one holds nothing.
    assertEquals(locks.held.size, 2);
    // Another principal is unaffected.
    assertEquals(
      (await subject.acquire({
        ...request("user:bob"),
        target: { kind: "model", modelType: "aws/ec2", modelId: ids[2] },
      })).kind,
      "acquired",
    );
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.dispose: releases every lease and ends waiting acquires", async () => {
  const locks = fakeLocks();
  const subject = leases(locks);
  const taken = await subject.acquire(request("user:alice"));
  assert(taken.kind === "acquired");
  const waiting = subject.acquire(request("user:bob", { waitMs: 60_000 }));
  await subject.dispose();
  assertEquals((await waiting).kind, "held");
  assertEquals(locks.held.size, 0);
  assertEquals(subject.size, 0);
  // After shutdown nothing is taken.
  assertEquals((await subject.acquire(request("user:carol"))).kind, "held");
  assertEquals(locks.held.size, 0);
});

Deno.test("asTryLock: refuses a lock that cannot be tried without waiting", () => {
  assertThrows(() => asTryLock({ release: () => Promise.resolve() }));
  const lock = {
    tryAcquire: () => Promise.resolve(true),
    release: () => Promise.resolve(),
  };
  assertEquals(asTryLock(lock), lock);
});
