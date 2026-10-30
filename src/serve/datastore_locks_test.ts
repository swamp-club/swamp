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
import { LockTimeoutError } from "../domain/datastore/distributed_lock.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  asTryLock,
  DatastoreLockLeases,
  type DatastoreLockLeasesOptions,
  LeaseRecordNotRemovedError,
  lockKeyOf,
  type LockTarget,
  lockTargetOfPartition,
  parseLockKey,
  type TryLock,
} from "./datastore_locks.ts";
import { partitionOf } from "../domain/datastore_v3/partition_key.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { leaseLockKeyOfPartition } from "../infrastructure/datastore_v3/serve_lease_registry.ts";
import { ControlPlaneLeaseStore } from "../infrastructure/datastore_v3/control_plane_lease_store.ts";

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
      await subject.renew("user:alice", taken.lease.leaseId, 60_000),
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
      await subject.renew("user:bob", taken.lease.leaseId, 60_000),
      undefined,
    );
    const renewed = await subject.renew(
      "user:alice",
      taken.lease.leaseId,
      90_000,
    );
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

// Fenced leases (swamp-club#4121).

Deno.test("DatastoreLockLeases.acquire: a fenced lease's fence is above the partition's lease fence and every fence issued for the key", async () => {
  const locks = fakeLocks();
  const subject = leases(locks);
  try {
    const base = { leaseFence: 4, names: [{ name: "vpc", highWater: 9 }] };
    const first = await subject.acquire({
      ...request("user:alice"),
      fenced: () => Promise.resolve(base),
    });
    assert(first.kind === "acquired");
    assertEquals(first.lease.fence, 5);
    assertEquals(first.lease.floor, base.names);
    assertEquals(subject.fencedLeaseOn(model), {
      leaseId: first.lease.leaseId,
      principal: "user:alice",
      fence: 5,
    });
    // While it lives, a second lease on the key starts above it: the
    // partition's own fence has not seen 5 yet.
    assertEquals(
      (await subject.acquire({
        ...request("user:bob"),
        fenced: () => Promise.resolve(base),
      })).kind,
      "held",
    );
    assert(await subject.release("user:alice", first.lease.leaseId));
    assertEquals(subject.fencedLeaseOn(model), undefined);
    // Once it ends, the next lease starts from the partition's fence: an
    // unused fence may come back, under another lease id serve checks.
    const second = await subject.acquire({
      ...request("user:bob"),
      fenced: () => Promise.resolve({ ...base, leaseFence: 5 }),
    });
    assert(second.kind === "acquired");
    assertEquals(second.lease.fence, 6);
    assert(second.lease.leaseId !== first.lease.leaseId);
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.acquire: an unfenced lease carries no fence and covers nothing", async () => {
  const locks = fakeLocks();
  const subject = leases(locks);
  try {
    const acquired = await subject.acquire(request("user:alice"));
    assert(acquired.kind === "acquired");
    assertEquals(acquired.lease.fence, undefined);
    assertEquals(acquired.lease.floor, undefined);
    assertEquals(subject.fencedLeaseOn(model), undefined);
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.acquire: a fence read that fails releases the lock and takes no lease", async () => {
  const locks = fakeLocks();
  const subject = leases(locks);
  try {
    let failed = false;
    try {
      await subject.acquire({
        ...request("user:alice"),
        fenced: () => Promise.reject(new Error("store unreadable")),
      });
    } catch {
      failed = true;
    }
    assert(failed);
    assertEquals(locks.held.has(lockKeyOf(model)), false);
    assertEquals(subject.size, 0);
  } finally {
    await subject.dispose();
  }
});

Deno.test("lockTargetOfPartition: a behavior's partition is its model lock's, a run's its claim's, and nothing else is covered", () => {
  assertEquals(
    lockTargetOfPartition(
      partitionOf({ kind: "model", type: ModelType.create("aws/ec2"), id: ID }),
    ),
    model,
  );
  assertEquals(
    lockTargetOfPartition(
      partitionOf({ kind: "run", workflowId: ID, runId: RUN }),
    ),
    { kind: "workflow-run", runId: RUN },
  );
  assertEquals(
    lockTargetOfPartition(partitionOf({ kind: "lockfile" })),
    undefined,
  );
  // Each covered partition's key is the lock key serve holds for it.
  assertEquals(
    lockKeyOf(
      lockTargetOfPartition(
        partitionOf({
          kind: "model",
          type: ModelType.create("aws/ec2"),
          id: ID,
        }),
      )!,
    ),
    "data/aws/ec2/" + ID + "/.lock",
  );
});

Deno.test("lockTargetOfPartition: serve's lock key for a partition is the one a checkout names its lease by", () => {
  for (
    const partition of [
      partitionOf({
        kind: "model",
        type: ModelType.create("@Scope/My-Type"),
        id: ID.toUpperCase(),
      }),
      partitionOf({ kind: "run", workflowId: ID, runId: RUN }),
    ]
  ) {
    assertEquals(
      leaseLockKeyOfPartition(partition),
      lockKeyOf(lockTargetOfPartition(partition)!),
    );
  }
});

Deno.test("asTryLock: refuses a lock that cannot be tried without waiting", () => {
  assertThrows(() => asTryLock({ release: () => Promise.resolve() }));
  const lock = {
    tryAcquire: () => Promise.resolve(true),
    release: () => Promise.resolve(),
  };
  assertEquals(asTryLock(lock), lock);
});

Deno.test("DatastoreLockLeases.acquire: a caller that hangs up while the fence is read takes no lease, and the lock is released", async () => {
  const locks = fakeLocks();
  const subject = leases(locks);
  try {
    const hangUp = new AbortController();
    const outcome = await subject.acquire({
      ...request("user:alice", { signal: hangUp.signal }),
      fenced: () => {
        hangUp.abort();
        return Promise.resolve({ leaseFence: undefined, names: [] });
      },
    });
    assertEquals(outcome.kind, "held");
    assertEquals(subject.size, 0);
    assertEquals(locks.held.has(lockKeyOf(model)), false);
  } finally {
    await subject.dispose();
  }
});

/** A control-plane store in memory, as every serve node shares one. */
function memoryControlPlane() {
  const records = new Map<string, Uint8Array>();
  const store = {
    records,
    put: (key: string, data: Uint8Array) => {
      records.set(key, data);
      return Promise.resolve();
    },
    get: (key: string) => Promise.resolve(records.get(key) ?? null),
    delete: (key: string) => {
      records.delete(key);
      return Promise.resolve();
    },
    list: (prefix: string) =>
      Promise.resolve(
        [...records.keys()].filter((key) => key.startsWith(prefix)).sort(),
      ),
  };
  return store;
}

/**
 * A serve node's leases over a shared control plane: its own locks, as a
 * node's file locks are its own, and the writer fence it leads at.
 */
function node(
  shared: ReturnType<typeof memoryControlPlane>,
  leaderFence: () => number | undefined,
  options: Partial<DatastoreLockLeasesOptions> = {},
) {
  const locks = fakeLocks();
  const subject = leases(locks, {
    persistence: { store: new ControlPlaneLeaseStore(shared), leaderFence },
    ...options,
  });
  return { locks, subject };
}

function explicit(principal: string, holdMs = 3_600_000) {
  return {
    ...request(principal, { ttlMs: holdMs }),
    holdMs,
    fenced: () => Promise.resolve({ leaseFence: undefined, names: [] }),
  };
}

Deno.test("DatastoreLockLeases: an explicit lease survives a takeover, and its holder renews it at the new leader", async () => {
  const shared = memoryControlPlane();
  const first = node(shared, () => 1);
  const second = node(shared, () => 2);
  try {
    await first.subject.adopt();
    const taken = await first.subject.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");
    // A command's lease is not kept.
    const command = await first.subject.acquire({
      ...request("user:bob"),
      target: { kind: "model", modelType: "aws/ec2", modelId: RUN },
    });
    assert(command.kind === "acquired");

    assert(second.subject.adopting);
    await second.subject.adopt();
    assertEquals(second.subject.adopting, false);
    assertEquals(second.subject.fencedLeaseOn(model), {
      leaseId: taken.lease.leaseId,
      principal: "user:alice",
      fence: taken.lease.fence,
    });
    assertEquals(second.subject.size, 1);
    assert(second.locks.held.has(lockKeyOf(model)));
    const renewed = await second.subject.renew(
      "user:alice",
      taken.lease.leaseId,
      3_600_000,
    );
    assertEquals(renewed?.leaseId, taken.lease.leaseId);
    // Nobody else takes the key while the adopted lease lives.
    assertEquals(
      await second.subject.acquire(explicit("user:bob")),
      { kind: "held", heldBy: "other" },
    );
  } finally {
    await first.subject.dispose();
    await second.subject.dispose();
  }
});

Deno.test("DatastoreLockLeases: the deposed leader's shutdown after a takeover leaves its successor's leases kept", async () => {
  const shared = memoryControlPlane();
  const first = node(shared, () => 1);
  const second = node(shared, () => 2);
  const third = node(shared, () => 3);
  try {
    await first.subject.adopt();
    const taken = await first.subject.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");
    await second.subject.adopt();
    // The deposed leader stops, as it does once it notices.
    await first.subject.dispose();
    assert(
      [...shared.records.keys()].some((key) => key.startsWith("leases/2/")),
    );
    // A later leader still finds the lease.
    await second.subject.dispose();
    await third.subject.adopt();
    assertEquals(
      third.subject.fencedLeaseOn(model)?.leaseId,
      taken.lease.leaseId,
    );
  } finally {
    await third.subject.dispose();
  }
});

Deno.test("DatastoreLockLeases: a deposed leader's late write lands in a prefix no later leader reads", async () => {
  const shared = memoryControlPlane();
  const first = node(shared, () => 1);
  const second = node(shared, () => 2);
  const third = node(shared, () => 3);
  try {
    await first.subject.adopt();
    await second.subject.adopt();
    // The deposed leader has not noticed, and grants a lease it records
    // under its own fence.
    const late = await first.subject.acquire(explicit("user:mallory"));
    assert(late.kind === "acquired");
    assert(
      [...shared.records.keys()].some((key) => key.startsWith("leases/1/")),
    );
    await third.subject.adopt();
    assertEquals(third.subject.fencedLeaseOn(model), undefined);
    assertEquals(third.subject.size, 0);
    // And the stale prefix is gone.
    assertEquals(
      [...shared.records.keys()].filter((key) => key.startsWith("leases/1/")),
      [],
    );
  } finally {
    await first.subject.dispose();
    await second.subject.dispose();
    await third.subject.dispose();
  }
});

Deno.test("DatastoreLockLeases: a restarted leader adopts the leases it kept before it stopped", async () => {
  const shared = memoryControlPlane();
  const before = node(shared, () => 4);
  await before.subject.adopt();
  const taken = await before.subject.acquire(explicit("user:alice"));
  assert(taken.kind === "acquired");
  await before.subject.dispose();
  // The same node again, at the fence it holds after the restart, whether
  // the writer lease kept its fence or took a new one.
  for (const fence of [4, 5]) {
    const after = node(shared, () => fence);
    try {
      await after.subject.adopt();
      assertEquals(
        after.subject.fencedLeaseOn(model)?.leaseId,
        taken.lease.leaseId,
      );
    } finally {
      await after.subject.dispose();
    }
  }
});

Deno.test("DatastoreLockLeases.adopt: an expired lease, or one a later fence superseded, is not adopted and its record goes", async () => {
  const shared = memoryControlPlane();
  let now = 1_000_000_000_000;
  const first = node(shared, () => 1, { now: () => now });
  await first.subject.adopt();
  const taken = await first.subject.acquire(explicit("user:alice", 60_000));
  assert(taken.kind === "acquired");
  const other: LockTarget = {
    kind: "model",
    modelType: "aws/ec2",
    modelId: RUN,
  };
  const second = await first.subject.acquire({
    ...explicit("user:bob", 3_600_000),
    target: other,
  });
  assert(second.kind === "acquired");
  await first.subject.dispose();

  // Past the first lease's hold and the skew allowed between clocks.
  now += 60_000 + 10_001;
  const next = node(shared, () => 2, { now: () => now });
  try {
    await next.subject.adopt({
      leaseFenceOf: (target) =>
        Promise.resolve(
          target.kind === "model" && target.modelId === RUN ? 99 : undefined,
        ),
    });
    assertEquals(next.subject.size, 0);
    assertEquals(
      [...shared.records.keys()].filter((key) => key !== "leases/2/complete"),
      [],
    );
  } finally {
    await next.subject.dispose();
  }
});

Deno.test("DatastoreLockLeases: an explicit lease the leader cannot record is not granted", async () => {
  const shared = memoryControlPlane();
  const locks = fakeLocks();
  const subject = leases(locks, {
    persistence: {
      store: {
        save: () => Promise.reject(new Error("control plane unreachable")),
        remove: () => Promise.resolve(),
        adopt: () => Promise.resolve([]),
      },
      leaderFence: () => 1,
    },
  });
  try {
    await subject.adopt();
    assertEquals(
      (await subject.acquire(explicit("user:alice"))).kind,
      "not-kept",
    );
    assertEquals(subject.size, 0);
    assertEquals(locks.held.has(lockKeyOf(model)), false);
    // A command's lease is never recorded, so it is granted.
    assertEquals(
      (await subject.acquire(request("user:alice"))).kind,
      "acquired",
    );
    assertEquals(shared.records.size, 0);
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.forceRelease: ends the lease whoever holds it, and forgets its record", async () => {
  const shared = memoryControlPlane();
  const leader = node(shared, () => 1);
  try {
    await leader.subject.adopt();
    const taken = await leader.subject.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");
    assertEquals(await leader.subject.forceRelease(model), {
      principal: "user:alice",
    });
    assertEquals(leader.subject.fencedLeaseOn(model), undefined);
    assertEquals(
      await leader.subject.renew("user:alice", taken.lease.leaseId, 60_000),
      undefined,
    );
    assertEquals(
      [...shared.records.keys()].filter((key) => key !== "leases/1/complete"),
      [],
    );
    assertEquals(await leader.subject.forceRelease(model), undefined);
  } finally {
    await leader.subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.adopt: a control plane that cannot be read keeps lease requests waiting, and adoption is retried until it succeeds", async () => {
  const shared = memoryControlPlane();
  const first = node(shared, () => 1);
  let failures = 1;
  const flaky = {
    ...shared,
    list: (prefix: string) => {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error("control plane unreachable"));
      }
      return shared.list(prefix);
    },
  };
  const locks = fakeLocks();
  const second = leases(locks, {
    persistence: {
      store: new ControlPlaneLeaseStore(flaky),
      leaderFence: () => 2,
    },
    adoptRetryMs: 5,
  });
  try {
    await first.subject.adopt();
    const taken = await first.subject.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");

    await second.adopt();
    // Not adopted yet: the gate stays shut rather than opening empty.
    assertEquals(second.adopting, true);
    await waitFor(() => !second.adopting, "the kept leases adopted");
    assertEquals(second.fencedLeaseOn(model)?.leaseId, taken.lease.leaseId);
  } finally {
    await first.subject.dispose();
    await second.dispose();
  }
});

Deno.test("DatastoreLockLeases.adopt: a lease that fails to adopt keeps the gate shut and is adopted on a retry, its record kept", async () => {
  const shared = memoryControlPlane();
  const first = node(shared, () => 1);
  const locks = fakeLocks();
  let failures = 1;
  const second = leases(locks, {
    createLock: (target) => {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error("lock directory unreadable"));
      }
      return locks.createLock(target);
    },
    persistence: {
      store: new ControlPlaneLeaseStore(shared),
      leaderFence: () => 2,
    },
    adoptRetryMs: 5,
  });
  try {
    await first.subject.adopt();
    const taken = await first.subject.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");

    await second.adopt();
    assertEquals(second.adopting, true);
    await waitFor(() => !second.adopting, "the kept leases adopted");
    assertEquals(second.fencedLeaseOn(model)?.leaseId, taken.lease.leaseId);
    // Its record is under the new leader's prefix, not forgotten.
    const third = node(shared, () => 3);
    try {
      await third.subject.adopt();
      assertEquals(
        third.subject.fencedLeaseOn(model)?.leaseId,
        taken.lease.leaseId,
      );
    } finally {
      await third.subject.dispose();
    }
  } finally {
    await first.subject.dispose();
    await second.dispose();
  }
});

Deno.test("DatastoreLockLeases.adopt: a live lease whose lock is still held at the takeover keeps its record and is adopted once the lock frees", async () => {
  const shared = memoryControlPlane();
  const first = node(shared, () => 1);
  const locks = fakeLocks();
  // A run of the leader before still holds serve's own lock on the key.
  locks.serveTakes(lockKeyOf(model));
  const second = leases(locks, {
    maxWaitMs: 20,
    adoptRetryMs: 5,
    persistence: {
      store: new ControlPlaneLeaseStore(shared),
      leaderFence: () => 2,
    },
  });
  try {
    await first.subject.adopt();
    const taken = await first.subject.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");

    await second.adopt();
    // Not adopted yet, and not forgotten: lease requests keep waiting.
    assertEquals(second.adopting, true);
    assertEquals(second.fencedLeaseOn(model), undefined);
    const records = [...shared.records.keys()].filter((key) =>
      !key.endsWith("/complete")
    );
    assert(records.length > 0, "the live lease's record is kept");

    locks.held.delete(lockKeyOf(model));
    await waitFor(() => !second.adopting, "the kept lease adopted");
    assertEquals(second.fencedLeaseOn(model)?.leaseId, taken.lease.leaseId);
    const renewed = await second.renew(
      "user:alice",
      taken.lease.leaseId,
      3_600_000,
    );
    assertEquals(renewed?.leaseId, taken.lease.leaseId);
  } finally {
    await first.subject.dispose();
    await second.dispose();
  }
});

Deno.test("DatastoreLockLeases.dispose: stops an adoption still retrying", async () => {
  const shared = memoryControlPlane();
  const failing = {
    ...shared,
    list: () => Promise.reject(new Error("control plane unreachable")),
  };
  const subject = leases(fakeLocks(), {
    persistence: {
      store: new ControlPlaneLeaseStore(failing),
      leaderFence: () => 1,
    },
    adoptRetryMs: 5,
  });
  await subject.adopt();
  assertEquals(subject.adopting, true);
  await subject.dispose();
  assertEquals(subject.adopting, true);
});

Deno.test("DatastoreLockLeases.acquire: an explicit lease refused because its record write failed is never adopted, though the write landed and its removal failed too", async () => {
  const shared = memoryControlPlane();
  // The put lands, then the reply is lost; the clean-up delete fails too.
  const flaky = {
    ...shared,
    put: async (key: string, data: Uint8Array) => {
      await shared.put(key, data);
      throw new Error("timed out after the write");
    },
    delete: () => Promise.reject(new Error("control plane unreachable")),
  };
  const locks = fakeLocks();
  const first = leases(locks, {
    persistence: {
      store: new ControlPlaneLeaseStore(flaky),
      leaderFence: () => 1,
    },
  });
  const second = node(shared, () => 2);
  try {
    // Leader 1's prefix is complete, so the next leader reads it.
    await shared.put("leases/1/complete", new TextEncoder().encode("now"));
    assertEquals(
      (await first.acquire(explicit("user:alice"))).kind,
      "not-kept",
    );
    // The landed record is there, but nobody was granted its lease.
    assert(
      [...shared.records.keys()].some((key) =>
        key.startsWith("leases/1/") && key !== "leases/1/complete"
      ),
    );
    await second.subject.adopt();
    assertEquals(second.subject.fencedLeaseOn(model), undefined);
    assertEquals(second.locks.held.has(lockKeyOf(model)), false);
  } finally {
    await first.dispose();
    await second.subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.forceRelease: a record that cannot be removed is reported, the lease still ends here, and a second force release removes it", async () => {
  const shared = memoryControlPlane();
  let failDeletes = true;
  const store = {
    ...shared,
    delete: (key: string) =>
      failDeletes
        ? Promise.reject(new Error("control plane unreachable"))
        : shared.delete(key),
  };
  const leader = leases(fakeLocks(), {
    persistence: {
      store: new ControlPlaneLeaseStore(store),
      leaderFence: () => 1,
    },
  });
  try {
    await leader.adopt();
    const taken = await leader.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");
    let refused: unknown;
    try {
      await leader.forceRelease(model);
    } catch (error) {
      refused = error;
    }
    assert(refused instanceof LeaseRecordNotRemovedError);
    assertEquals(leader.fencedLeaseOn(model), undefined);
    assert(
      [...shared.records.keys()].some((key) =>
        key.startsWith("leases/1/") && key !== "leases/1/complete"
      ),
    );
    failDeletes = false;
    assertEquals(await leader.forceRelease(model), undefined);
    assertEquals(
      [...shared.records.keys()].filter((key) => key !== "leases/1/complete"),
      [],
    );
  } finally {
    await leader.dispose();
  }
});

Deno.test("DatastoreLockLeases.dispose: a shutdown while a lease waits for its lock in adoption leaves its record for the next leader", async () => {
  const shared = memoryControlPlane();
  const first = node(shared, () => 1);
  const locks = fakeLocks();
  // Serve's own work holds the key, so the adoption waits for its lock.
  locks.serveTakes(lockKeyOf(model));
  let waiting = false;
  const second = leases(locks, {
    createLock: (target) => {
      waiting = true;
      return locks.createLock(target);
    },
    maxWaitMs: 60_000,
    persistence: {
      store: new ControlPlaneLeaseStore(shared),
      leaderFence: () => 2,
    },
  });
  try {
    await first.subject.adopt();
    const taken = await first.subject.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");
    const adopting = second.adopt();
    await waitFor(() => waiting, "the adoption waits for the lease's lock");
    await second.dispose();
    await adopting;
    const third = node(shared, () => 3);
    try {
      await third.subject.adopt();
      assertEquals(
        third.subject.fencedLeaseOn(model)?.leaseId,
        taken.lease.leaseId,
      );
    } finally {
      await third.subject.dispose();
    }
  } finally {
    await first.subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.acquire: an explicit lease whose record cannot be confirmed is granted, and a takeover before its next renewal ends it", async () => {
  const shared = memoryControlPlane();
  let puts = 0;
  // The pending record is written; its confirmation is not.
  const store = {
    ...shared,
    put: (key: string, data: Uint8Array) =>
      ++puts === 2
        ? Promise.reject(new Error("control plane unreachable"))
        : shared.put(key, data),
  };
  const first = leases(fakeLocks(), {
    persistence: {
      store: new ControlPlaneLeaseStore(store),
      leaderFence: () => 1,
    },
  });
  const second = node(shared, () => 2);
  try {
    await shared.put("leases/1/complete", new TextEncoder().encode("now"));
    assertEquals(
      (await first.acquire(explicit("user:alice"))).kind,
      "acquired",
    );
    await second.subject.adopt();
    assertEquals(second.subject.fencedLeaseOn(model), undefined);
  } finally {
    await first.dispose();
    await second.subject.dispose();
  }
});

/**
 * A shared control plane whose next write can be held: `hold()` makes the
 * next put wait until the returned function is called.
 */
function holdableControlPlane() {
  const shared = memoryControlPlane();
  let gate: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const store = {
    ...shared,
    put: async (key: string, data: Uint8Array) => {
      const waiting = gate;
      gate = undefined;
      if (waiting !== undefined) {
        entered?.();
        await waiting;
      }
      await shared.put(key, data);
    },
  };
  return {
    shared,
    store,
    /** Holds the next put; resolves `started` once it is waiting. */
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      const started = new Promise<void>((resolve) => (entered = resolve));
      return { release, started };
    },
  };
}

function leaseRecords(shared: ReturnType<typeof memoryControlPlane>) {
  return [...shared.records.keys()].filter((key) =>
    key.startsWith("leases/1/") && key !== "leases/1/complete"
  );
}

Deno.test("DatastoreLockLeases.renew: a renewal racing a forced release leaves no record and renews nothing", async () => {
  const plane = holdableControlPlane();
  const subject = leases(fakeLocks(), {
    persistence: {
      store: new ControlPlaneLeaseStore(plane.store),
      leaderFence: () => 1,
    },
  });
  try {
    await subject.adopt();
    const taken = await subject.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");
    assertEquals(leaseRecords(plane.shared).length, 1);
    const held = plane.hold();
    const renewing = subject.renew(
      "user:alice",
      taken.lease.leaseId,
      3_600_000,
    );
    await held.started;
    const releasing = subject.forceRelease(model);
    held.release();
    assertEquals(await renewing, undefined);
    assertEquals((await releasing)?.principal, "user:alice");
    assertEquals(leaseRecords(plane.shared), []);
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.acquire: a confirmation racing a forced release leaves no record and the lease is not granted", async () => {
  const plane = holdableControlPlane();
  const locks = fakeLocks();
  const subject = leases(locks, {
    persistence: {
      store: new ControlPlaneLeaseStore(plane.store),
      leaderFence: () => 1,
    },
  });
  try {
    await subject.adopt();
    // The pending write goes through; the confirming one is held.
    let puts = 0;
    const store = plane.store;
    const put = store.put;
    let held: ReturnType<typeof plane.hold> | undefined;
    store.put = async (key: string, data: Uint8Array) => {
      const first = ++puts === 1;
      await put(key, data);
      // Held from the next write on: the confirmation.
      if (first) held = plane.hold();
    };
    const acquiring = subject.acquire(explicit("user:alice"));
    await waitFor(() => held !== undefined, "the pending write landed");
    await held!.started;
    const releasing = subject.forceRelease(model);
    held!.release();
    assertEquals((await acquiring).kind, "not-kept");
    await releasing;
    assertEquals(leaseRecords(plane.shared), []);
    assertEquals(locks.held.has(lockKeyOf(model)), false);
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.adopt: each lead adopts afresh, so lease requests wait again in a process that led before", async () => {
  const shared = memoryControlPlane();
  let fence = 1;
  const { subject } = node(shared, () => fence);
  try {
    await subject.adopt();
    assertEquals(subject.adopting, false);
    fence = 2;
    const adopting = subject.adopt();
    assertEquals(subject.adopting, true);
    await adopting;
    assertEquals(subject.adopting, false);
  } finally {
    await subject.dispose();
  }
});

Deno.test("DatastoreLockLeases.whenAdopted: serve's own run waits for a kept lease on its key to be adopted, and only on that key (swamp-club#4195)", async () => {
  const shared = memoryControlPlane();
  const first = node(shared, () => 1);
  const locks = fakeLocks();
  locks.serveTakes(lockKeyOf(model));
  const second = leases(locks, {
    maxWaitMs: 20,
    adoptRetryMs: 5,
    persistence: {
      store: new ControlPlaneLeaseStore(shared),
      leaderFence: () => 2,
    },
  });
  const other = lockKeyOf({ ...model, modelId: RUN });
  try {
    await first.subject.adopt();
    const taken = await first.subject.acquire(explicit("user:alice"));
    assert(taken.kind === "acquired");
    await second.adopt();
    assertEquals(second.adoptionPending(lockKeyOf(model)), true);
    // A key no kept lease is on is free at once.
    assertEquals(second.adoptionPending(other), false);
    await second.whenAdopted(other, 0);
    // Still pending past the wait: the run gets a lock timeout.
    await assertRejects(
      () => second.whenAdopted(lockKeyOf(model), 10),
      LockTimeoutError,
    );
    // Once the lock frees, the lease is adopted and the run may go on.
    const waiting = second.whenAdopted(lockKeyOf(model), 10_000);
    locks.held.delete(lockKeyOf(model));
    await waiting;
    assertEquals(second.adopting, false);
    assertEquals(second.fencedLeaseOn(model)?.leaseId, taken.lease.leaseId);
  } finally {
    await first.subject.dispose();
    await second.dispose();
  }
});

Deno.test("DatastoreLockLeases.whenAdopted: while the kept leases cannot even be read, every key waits (swamp-club#4195)", async () => {
  const shared = memoryControlPlane();
  const failing = {
    ...shared,
    list: () => Promise.reject(new Error("control plane unreachable")),
  };
  const subject = leases(fakeLocks(), {
    persistence: {
      store: new ControlPlaneLeaseStore(failing),
      leaderFence: () => 1,
    },
    adoptRetryMs: 5,
  });
  try {
    await subject.adopt();
    assertEquals(subject.adoptionPending(lockKeyOf(model)), true);
    await assertRejects(
      () => subject.whenAdopted(lockKeyOf(model), 10),
      LockTimeoutError,
    );
  } finally {
    await subject.dispose();
  }
});
