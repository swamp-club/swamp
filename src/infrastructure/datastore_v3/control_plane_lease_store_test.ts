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

import { assertEquals } from "@std/assert";
import type { PersistedLease } from "../../domain/datastore_v3/persisted_lease.ts";
import { ControlPlaneLeaseStore } from "./control_plane_lease_store.ts";

/** A control-plane store in memory, recording the order of deletes. */
function memoryControlPlane() {
  const records = new Map<string, Uint8Array>();
  const deletes: string[] = [];
  return {
    records,
    deletes,
    put: (key: string, data: Uint8Array) => {
      records.set(key, data);
      return Promise.resolve();
    },
    get: (key: string) => Promise.resolve(records.get(key) ?? null),
    delete: (key: string) => {
      deletes.push(key);
      records.delete(key);
      return Promise.resolve();
    },
    list: (prefix: string) =>
      Promise.resolve(
        [...records.keys()].filter((key) => key.startsWith(prefix)).sort(),
      ),
  };
}

function lease(lockKey: string, leaderFence: number): PersistedLease {
  return {
    leaseId: crypto.randomUUID(),
    lockKey,
    principal: "user:alice",
    fence: 1,
    holdMs: 60_000,
    remainingMs: 60_000,
    recordedAt: new Date().toISOString(),
    leaderFence,
  };
}

const MARK = new TextEncoder().encode("done");

Deno.test("ControlPlaneLeaseStore.adopt: copies the newest complete prefix under the adopter's, marks it, then deletes the older ones mark first", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneLeaseStore(shared);
  await store.save(9, lease("data/a/1/.lock", 9));
  await shared.put("leases/9/complete", MARK);
  // Fences compare as numbers: 10 is newer than 9.
  await store.save(10, lease("data/b/1/.lock", 10));
  await shared.put("leases/10/complete", MARK);

  const adopted = await store.adopt(11);
  assertEquals(adopted.map((l) => [l.lockKey, l.leaderFence]), [
    ["data/b/1/.lock", 11],
  ]);
  const keys = [...shared.records.keys()];
  assertEquals(keys.filter((key) => !key.startsWith("leases/11/")), []);
  assertEquals(keys.includes("leases/11/complete"), true);
  // Each older prefix lost its mark before its records.
  for (const fence of [9, 10]) {
    const ofPrefix = shared.deletes.filter((key) =>
      key.startsWith(`leases/${fence}/`)
    );
    assertEquals(ofPrefix[0], `leases/${fence}/complete`);
  }
});

Deno.test("ControlPlaneLeaseStore.adopt: a prefix with no mark, left by a crash mid-adoption, is skipped for the complete one below it", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneLeaseStore(shared);
  await store.save(3, lease("data/a/1/.lock", 3));
  await shared.put("leases/3/complete", MARK);
  // Leader 4 copied, then crashed before its mark.
  await store.save(4, lease("data/a/1/.lock", 4));
  await store.save(4, lease("data/z/1/.lock", 4));

  const adopted = await store.adopt(5);
  assertEquals(adopted.map((l) => l.lockKey), ["data/a/1/.lock"]);
});

Deno.test("ControlPlaneLeaseStore.adopt: a later leader's prefix is neither read nor deleted", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneLeaseStore(shared);
  await store.save(8, lease("data/a/1/.lock", 8));
  await shared.put("leases/8/complete", MARK);
  assertEquals(await store.adopt(7), []);
  assertEquals(shared.records.has("leases/8/complete"), true);
});

Deno.test("ControlPlaneLeaseStore.adopt: a leader adopting its own complete prefix again copies nothing and keeps it", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneLeaseStore(shared);
  await store.adopt(2);
  await store.save(2, lease("data/a/1/.lock", 2));
  const adopted = await store.adopt(2);
  assertEquals(adopted.map((l) => l.lockKey), ["data/a/1/.lock"]);
  assertEquals(shared.deletes, []);
});

Deno.test("ControlPlaneLeaseStore.adopt: an unreadable record, or one filed under another key, is skipped", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneLeaseStore(shared);
  await store.save(1, lease("data/a/1/.lock", 1));
  await shared.put("leases/1/garbage", new TextEncoder().encode("{"));
  // A valid record under a key that is not its lock key's.
  const misfiled = new TextEncoder().encode(
    JSON.stringify(lease("data/m/1/.lock", 1)),
  );
  await shared.put(`leases/1/${"0".repeat(64)}`, misfiled);
  await shared.put("leases/1/complete", MARK);
  const adopted = await store.adopt(2);
  assertEquals(adopted.map((l) => l.lockKey), ["data/a/1/.lock"]);
});

Deno.test("ControlPlaneLeaseStore.remove: removes a lock key's record from one leader's prefix only", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneLeaseStore(shared);
  await store.save(1, lease("data/a/1/.lock", 1));
  await store.save(2, lease("data/a/1/.lock", 2));
  await store.remove(2, "data/a/1/.lock");
  assertEquals(
    [...shared.records.keys()].map((key) => key.split("/")[1]),
    ["1"],
  );
});
