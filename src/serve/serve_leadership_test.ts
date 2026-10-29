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
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  parseServeLeader,
  serializeServeLeader,
  SERVE_LEADER_KEY,
} from "../domain/datastore_v3/serve_leader.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { type LeadershipLease, ServeLeadership } from "./serve_leadership.ts";

await initializeLogging({});

function memoryStore(): ControlPlaneStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    get: (key) => Promise.resolve(data.get(key) ?? null),
    put: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve([...data.keys()].filter((key) => key.startsWith(prefix))),
  };
}

/** A lease the test moves by hand. */
class FakeLease implements LeadershipLease {
  /** undefined: holds nothing; otherwise the fence and whether it is lost. */
  hold: { fence: number; lost: boolean } | undefined;
  /** What the next take finds: free (taken at this fence) or busy. */
  free: number | undefined;
  takes = 0;
  holdsCurrent = () => this.hold !== undefined && !this.hold.lost;
  fence = () => this.hold?.fence;
  take = (): Promise<"writer" | "follower"> => {
    this.takes++;
    if (this.free === undefined) return Promise.resolve("follower");
    this.hold = { fence: this.free, lost: false };
    this.free = undefined;
    return Promise.resolve("writer");
  };
}

function setup(options: { now?: () => number } = {}) {
  const lease = new FakeLease();
  const store = memoryStore();
  const events: string[] = [];
  const leadership = new ServeLeadership({
    instanceId: "me",
    address: "http://10.0.0.1:9090",
    lease,
    store,
    refreshCopy: () => {
      events.push("refresh");
      return Promise.resolve();
    },
    onLead: () => {
      events.push("lead");
      return Promise.resolve();
    },
    onLostLead: () => {
      events.push("lost");
      return Promise.resolve();
    },
    // Ticks are driven by hand.
    tickMs: 3_600_000,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { lease, store, events, leadership };
}

function recorded(store: { data: Map<string, Uint8Array> }) {
  const data = store.data.get(SERVE_LEADER_KEY);
  return data === undefined ? undefined : parseServeLeader(data);
}

Deno.test("ServeLeadership: a node that took the lease leads and records itself", async () => {
  const { lease, store, events, leadership } = setup();
  lease.hold = { fence: 4, lost: false };
  await leadership.start("writer");
  try {
    assertEquals(leadership.role, "leader");
    assertEquals(events, ["lead"]);
    assertEquals(recorded(store)?.instanceId, "me");
    assertEquals(recorded(store)?.fence, 4);
    assertEquals(recorded(store)?.address, "http://10.0.0.1:9090");
    assertEquals(leadership.isStale(), false);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a follower refreshes, names the leader, and takes over once the lease is free", async () => {
  const { lease, store, events, leadership } = setup();
  await store.put(
    SERVE_LEADER_KEY,
    serializeServeLeader({
      instanceId: "other",
      fence: 2,
      since: new Date().toISOString(),
    }),
  );
  await leadership.start("follower");
  try {
    assertEquals(leadership.role, "follower");
    assertEquals(leadership.leader()?.instanceId, "other");
    await leadership.tick();
    assertEquals(events, ["refresh"]);
    assertEquals(lease.takes, 1);
    lease.free = 3;
    await leadership.tick();
    assertEquals(leadership.role, "leader");
    assertEquals(events, ["refresh", "lead"]);
    assertEquals(recorded(store)?.instanceId, "me");
    assertEquals(recorded(store)?.fence, 3);
    assertEquals(leadership.leader()?.instanceId, "me");
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a leader whose lease is taken over stops once, and never follows or takes the lease itself", async () => {
  const { lease, events, leadership } = setup();
  lease.hold = { fence: 5, lost: false };
  await leadership.start("writer");
  try {
    lease.hold.lost = true;
    await leadership.tick();
    assertEquals(events, ["lead", "lost"]);
    // Stopped: later ticks take nothing and report nothing again.
    lease.free = 9;
    await leadership.tick();
    await leadership.tick();
    assertEquals(events, ["lead", "lost"]);
    assertEquals(lease.takes, 0);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a node takes the follower's gates down only once its leader work is done", async () => {
  const lease = new FakeLease();
  let roleDuringLead: string | undefined;
  const leadership: ServeLeadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    refreshCopy: () => Promise.resolve(),
    onLead: () => {
      roleDuringLead = leadership.role;
      return Promise.resolve();
    },
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  try {
    lease.free = 2;
    await leadership.tick();
    assertEquals(roleDuringLead, "follower");
    assertEquals(leadership.role, "leader");
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a leader rewrites its record when its fence moves", async () => {
  const { lease, store, leadership } = setup();
  lease.hold = { fence: 8, lost: false };
  await leadership.start("writer");
  try {
    lease.hold = { fence: 9, lost: false };
    await leadership.tick();
    assertEquals(recorded(store)?.fence, 9);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a follower's copy goes stale once it misses refreshes for the bound", async () => {
  let now = 1_000_000;
  const { lease, leadership } = setup({ now: () => now });
  await leadership.start("follower");
  try {
    assertEquals(leadership.isStale(), false);
    now += 30_001;
    assertEquals(leadership.isStale(), true);
    await leadership.tick();
    assertEquals(leadership.isStale(), false);
    assertEquals(lease.takes, 1);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: its own old record names no leader to it as a follower", async () => {
  const { store, leadership } = setup();
  await store.put(
    SERVE_LEADER_KEY,
    serializeServeLeader({
      instanceId: "me",
      fence: 1,
      since: new Date().toISOString(),
    }),
  );
  await leadership.start("follower");
  try {
    assertEquals(leadership.leader(), undefined);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a node that took the lease at boot leads while its record is still being written", async () => {
  const lease = new FakeLease();
  lease.hold = { fence: 3, lost: false };
  const store = memoryStore();
  const put = Promise.withResolvers<void>();
  let roleDuringPut: string | undefined;
  const leadership: ServeLeadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: {
      ...store,
      put: async (key, data) => {
        roleDuringPut = leadership.role;
        staleDuringPut = leadership.isStale();
        await put.promise;
        await store.put(key, data);
      },
    },
    refreshCopy: () => Promise.resolve(),
    onLead: () => Promise.resolve(),
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  let staleDuringPut: boolean | undefined;
  const starting = leadership.start("writer");
  await Promise.resolve();
  put.resolve();
  await starting;
  try {
    assertEquals(roleDuringPut, "leader");
    assertEquals(staleDuringPut, false);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a lost-lead handler that stops the leadership, as serve's shutdown does, never deadlocks", async () => {
  const lease = new FakeLease();
  lease.hold = { fence: 2, lost: false };
  let stopped = false;
  const leadership: ServeLeadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    refreshCopy: () => Promise.resolve(),
    onLead: () => Promise.resolve(),
    onLostLead: async () => {
      // Serve's shutdown drains and stops other services first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await leadership.stop();
      stopped = true;
    },
    tickMs: 3_600_000,
  });
  await leadership.start("writer");
  lease.hold.lost = true;
  await leadership.tick();
  await leadership.lostLeadHandled();
  assertEquals(stopped, true);
  assertEquals(leadership.role, "follower");
});

Deno.test("ServeLeadership: a node whose leader record cannot be written does not lead yet, and tries again", async () => {
  const lease = new FakeLease();
  const store = memoryStore();
  let failPuts = 1;
  const leads: string[] = [];
  const leadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: {
      ...store,
      put: (key, data) => {
        if (failPuts > 0) {
          failPuts--;
          return Promise.reject(new Error("bucket unavailable"));
        }
        return store.put(key, data);
      },
    },
    refreshCopy: () => Promise.resolve(),
    onLead: () => {
      leads.push("lead");
      return Promise.resolve();
    },
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  try {
    lease.free = 4;
    await leadership.tick();
    assertEquals(leadership.role, "follower");
    assertEquals(leads, []);
    // Still holding the lease, the next tick writes the record and leads,
    // without taking the lease again.
    const takesBefore = lease.takes;
    await leadership.tick();
    assertEquals(lease.takes, takesBefore);
    assertEquals(leadership.role, "leader");
    assertEquals(leads, ["lead"]);
  } finally {
    await leadership.stop();
  }
});
