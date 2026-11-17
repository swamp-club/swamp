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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  parseServeLeader,
  serializeServeLeader,
  SERVE_LEADER_KEY,
  type ServeLeader,
} from "../domain/datastore_v3/serve_leader.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import {
  AWAIT_NEW_LEADER_MS,
  type FollowerCopyFeed,
  type LeadershipLease,
  ServeLeadership,
} from "./serve_leadership.ts";

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

class FakeLease implements LeadershipLease {
  hold: { fence: number; lost: boolean } | undefined;
  free: number | undefined;
  takes = 0;
  current: number | "unreadable" | undefined;
  /** the holder's computed expiry; with freeFrom, take wins once it passes */
  expiry: number | undefined;
  freeFrom: { at: number; fence: number } | undefined;
  holdsCurrent = () => this.hold !== undefined && !this.hold.lost;
  expiresAt = (): Promise<number | undefined> => Promise.resolve(this.expiry);
  currentFence = (): Promise<number | undefined> =>
    this.current === "unreadable"
      ? Promise.reject(new Error("lease unreadable"))
      : Promise.resolve(this.current ?? this.hold?.fence);
  fence = () => this.hold?.fence;
  lostListeners = new Set<() => void>();
  onLost = (listener: () => void): () => void => {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  };
  lose(): void {
    if (this.hold !== undefined) this.hold.lost = true;
    for (const listener of [...this.lostListeners]) listener();
  }
  take = (): Promise<"writer" | "follower"> => {
    this.takes++;
    if (this.freeFrom !== undefined && Date.now() > this.freeFrom.at) {
      this.free = this.freeFrom.fence;
      this.freeFrom = undefined;
    }
    if (this.free === undefined) return Promise.resolve("follower");
    this.hold = { fence: this.free, lost: false };
    this.free = undefined;
    return Promise.resolve("writer");
  };
}

class FakeFeed implements FollowerCopyFeed {
  current_ = false;
  followed: (string | undefined)[] = [];
  stops = 0;
  current = () => this.current_;
  follow = (leader: { instanceId: string } | undefined) => {
    this.followed.push(leader?.instanceId);
  };
  stop = () => {
    this.stops++;
    return Promise.resolve();
  };
}

function setup(
  options: {
    now?: () => number;
    feed?: FollowerCopyFeed;
    trust?: (leader: ServeLeader) => Promise<boolean>;
    prove?: (leader: ServeLeader) => Promise<string | undefined>;
  } = {},
) {
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
    tickMs: 3_600_000,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.feed !== undefined ? { feed: options.feed } : {}),
    ...(options.trust !== undefined ? { trust: options.trust } : {}),
    ...(options.prove !== undefined ? { prove: options.prove } : {}),
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
    lease.free = 9;
    await leadership.tick();
    await leadership.tick();
    assertEquals(events, ["lead", "lost"]);
    assertEquals(lease.takes, 0);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a leader stops as soon as its lease reports lost, not on the next tick", async () => {
  const { lease, events, leadership } = setup();
  lease.hold = { fence: 5, lost: false };
  await leadership.start("writer");
  try {
    lease.lose();
    await waitFor(
      () => leadership.role === "follower",
      "the leader to give up its role",
      { timeoutMs: 2_000 },
    );
    await leadership.lostLeadHandled();
    assertEquals(events, ["lead", "lost"]);
    assertEquals(lease.takes, 0);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a lease lost while a tick is in flight is checked again once that tick ends", async () => {
  let block: PromiseWithResolvers<void> | undefined;
  const { lease, events, leadership } = setup({
    prove: async () => {
      await block?.promise;
      return "proof";
    },
  });
  lease.hold = { fence: 5, lost: false };
  await leadership.start("writer");
  try {
    block = Promise.withResolvers<void>();
    const inFlight = leadership.tick();
    lease.lose();
    block.resolve();
    await inFlight;
    await waitFor(
      () => leadership.role === "follower",
      "the leader to give up its role",
      { timeoutMs: 2_000 },
    );
    await leadership.lostLeadHandled();
    assertEquals(events, ["lead", "lost"]);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership.leadLost: a hold lost while its retake may still win it back keeps the leader ready; once the hold reports it lost, the leader is not ready and gives up the lead", async () => {
  const { lease, events, leadership } = setup();
  assertEquals(leadership.leadLost(), false);
  lease.hold = { fence: 5, lost: false };
  await leadership.start("writer");
  try {
    assertEquals(leadership.leadLost(), false);
    // lost but retaking: a readiness probe neither reports it nor acts on it
    lease.hold.lost = true;
    assertEquals(leadership.leadLost(), false);
    await Promise.resolve();
    assertEquals(leadership.role, "leader");
    assertEquals(events, ["lead"]);
    lease.hold.lost = false;
    assertEquals(leadership.leadLost(), false);
    // the hold gave up: reported at once, and the lead is given up
    lease.lose();
    assertEquals(leadership.leadLost(), true);
    await waitFor(
      () => leadership.role === "follower",
      "the leader to give up its role",
      { timeoutMs: 2_000 },
    );
    await leadership.lostLeadHandled();
    assertEquals(events, ["lead", "lost"]);
    assertEquals(leadership.leadLost(), true);
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

Deno.test("ServeLeadership: a follower that takes the lease aborts its forwards to the old leader before its leader work, and again before its role changes", async () => {
  const lease = new FakeLease();
  const feed = new FakeFeed();
  const events: string[] = [];
  const leadership: ServeLeadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    feed: {
      current: () => true,
      follow: feed.follow,
      stop: () => {
        events.push(`feed-stop:${leadership.role}`);
        return Promise.resolve();
      },
    },
    refreshCopy: () => Promise.resolve(),
    abortForwards: () => {
      events.push(`abort:${leadership.role}`);
    },
    onLead: () => {
      events.push(`lead:${leadership.role}`);
      return Promise.resolve();
    },
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  try {
    await leadership.tick();
    assertEquals(events, []);
    lease.free = 2;
    await leadership.tick();
    assertEquals(events, [
      "abort:follower",
      "feed-stop:follower",
      "lead:follower",
      "abort:follower",
    ]);
    assertEquals(leadership.role, "leader");
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: onLed runs once the promoted node's role is leader", async () => {
  const lease = new FakeLease();
  const roles: string[] = [];
  const leadership: ServeLeadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    refreshCopy: () => Promise.resolve(),
    onLead: () => {
      roles.push(`lead:${leadership.role}`);
      return Promise.resolve();
    },
    onLed: () => {
      roles.push(`led:${leadership.role}`);
      return Promise.reject(new Error("led work failed"));
    },
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  try {
    lease.free = 2;
    await leadership.tick();
    assertEquals(roles, ["lead:follower", "led:leader"]);
    assertEquals(leadership.role, "leader");
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: onLed is not called for a lead taken at boot", async () => {
  const lease = new FakeLease();
  lease.hold = { fence: 8, lost: false };
  let led = 0;
  const booted = new ServeLeadership({
    instanceId: "boot",
    lease,
    store: memoryStore(),
    refreshCopy: () => Promise.resolve(),
    onLead: () => Promise.resolve(),
    onLed: () => {
      led++;
      return Promise.resolve();
    },
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await booted.start("writer");
  try {
    assertEquals(led, 0);
  } finally {
    await booted.stop();
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
    const takesBefore = lease.takes;
    await leadership.tick();
    assertEquals(lease.takes, takesBefore);
    assertEquals(leadership.role, "leader");
    assertEquals(leads, ["lead"]);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a follower whose commit feed is current restores nothing; one whose feed stopped restores and follows again", async () => {
  const feed = new FakeFeed();
  const { store, events, leadership } = setup({ feed });
  await store.put(
    SERVE_LEADER_KEY,
    serializeServeLeader({
      instanceId: "other",
      fence: 2,
      address: "http://10.0.0.2:9090",
      since: new Date().toISOString(),
    }),
  );
  await leadership.start("follower");
  try {
    assertEquals(feed.followed, ["other"]);
    feed.current_ = true;
    await leadership.tick();
    assertEquals(events, []);
    feed.current_ = false;
    await leadership.tick();
    assertEquals(events, ["refresh"]);
    assertEquals(feed.followed, ["other", "other"]);
  } finally {
    await leadership.stop();
  }
  assertEquals(feed.stops, 2);
});

Deno.test("ServeLeadership: taking the lead stops following the feed", async () => {
  const feed = new FakeFeed();
  const { lease, leadership } = setup({ feed });
  await leadership.start("follower");
  try {
    lease.free = 4;
    await leadership.tick();
    assertEquals(leadership.role, "leader");
    assertEquals(feed.stops, 1);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership.markRefreshed: keeps a follower fresh between ticks, and a leader is never stale", async () => {
  let now = 0;
  const { leadership } = setup({ now: () => now });
  await leadership.start("follower");
  try {
    now = 25_000;
    leadership.markRefreshed();
    now = 50_000;
    assertEquals(leadership.isStale(), false);
    now = 56_000;
    assertEquals(leadership.isStale(), true);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a leader record without the team's proof names the leader but not its address", async () => {
  const { lease, store, leadership } = setup({
    trust: (leader) => Promise.resolve(leader.proof === "good"),
  });
  lease.current = 2;
  const record = {
    instanceId: "other",
    fence: 2,
    address: "https://somewhere.example",
    since: new Date().toISOString(),
  };
  await store.put(SERVE_LEADER_KEY, serializeServeLeader(record));
  await leadership.start("follower");
  try {
    assertEquals(leadership.leader()?.instanceId, "other");
    assertEquals(leadership.leader()?.address, undefined);
    await store.put(
      SERVE_LEADER_KEY,
      serializeServeLeader({ ...record, proof: "good" }),
    );
    await leadership.tick();
    assertEquals(leadership.leader()?.address, "https://somewhere.example");
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a leader signs the record it writes", async () => {
  const { lease, store, leadership } = setup({
    prove: (leader) => Promise.resolve(`signed:${leader.fence}`),
  });
  lease.free = 5;
  await leadership.start("follower");
  try {
    await leadership.tick();
    assertEquals(recorded(store)?.proof, "signed:5");
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a leader signs its record again once its proof changes, and still writes it when signing fails", async () => {
  let key = "k1";
  let failing = true;
  const { lease, store, leadership } = setup({
    prove: (leader) =>
      failing
        ? Promise.reject(new Error("vault down"))
        : Promise.resolve(`${key}:${leader.fence}`),
  });
  lease.free = 5;
  await leadership.start("follower");
  try {
    await leadership.tick();
    assertEquals(recorded(store)?.instanceId, "me");
    assertEquals(recorded(store)?.proof, undefined);
    failing = false;
    await leadership.tick();
    assertEquals(recorded(store)?.proof, "k1:5");
    key = "k2";
    await leadership.tick();
    assertEquals(recorded(store)?.proof, "k2:5");
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a signed record from an older fence, written back after a takeover, gets nothing forwarded to its address", async () => {
  const { lease, store, leadership } = setup({
    trust: () => Promise.resolve(true),
  });
  const record = (fence: number, address: string) =>
    serializeServeLeader({
      instanceId: `leader-${fence}`,
      fence,
      address,
      since: new Date().toISOString(),
      proof: "signed",
    });
  lease.current = 4;
  await store.put(SERVE_LEADER_KEY, record(4, "https://new.example"));
  await leadership.start("follower");
  try {
    assertEquals(leadership.leader()?.address, "https://new.example");
    await store.put(SERVE_LEADER_KEY, record(3, "https://old.example"));
    await leadership.tick();
    assertEquals(leadership.leader()?.instanceId, "leader-3");
    assertEquals(leadership.leader()?.address, undefined);
    lease.current = 5;
    await store.put(SERVE_LEADER_KEY, record(4, "https://new.example"));
    await leadership.tick();
    assertEquals(leadership.leader()?.address, undefined);
    await store.put(SERVE_LEADER_KEY, record(5, "https://next.example"));
    await leadership.tick();
    assertEquals(leadership.leader()?.address, "https://next.example");
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a lease fence that cannot be read forwards nothing", async () => {
  const { lease, store, leadership } = setup({
    trust: () => Promise.resolve(true),
  });
  lease.current = "unreadable";
  await store.put(
    SERVE_LEADER_KEY,
    serializeServeLeader({
      instanceId: "other",
      fence: 2,
      address: "https://somewhere.example",
      since: new Date().toISOString(),
      proof: "signed",
    }),
  );
  await leadership.start("follower");
  try {
    assertEquals(leadership.leader()?.instanceId, "other");
    assertEquals(leadership.leader()?.address, undefined);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a feed that is not current is stopped before the restore runs (swamp-club#4148)", async () => {
  const order: string[] = [];
  const feed: FollowerCopyFeed = {
    current: () => false,
    follow: () => order.push("follow"),
    stop: () => {
      order.push("stop");
      return Promise.resolve();
    },
  };
  const lease = new FakeLease();
  const leadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    feed,
    refreshCopy: () => {
      order.push("refresh");
      return Promise.resolve();
    },
    onLead: () => Promise.resolve(),
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  try {
    order.length = 0;
    await leadership.tick();
    assertEquals(order, ["stop", "refresh", "follow"]);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership.stop: a promotion in flight sees the stop and never takes the leader role (swamp-club#4327)", async () => {
  const lease = new FakeLease();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let stoppedSeen: boolean | undefined;
  let led = false;
  const leadership: ServeLeadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    refreshCopy: () => Promise.resolve(),
    onLead: async (stopped) => {
      entered.resolve();
      await gate.promise;
      stoppedSeen = stopped();
    },
    onLed: () => {
      led = true;
      return Promise.resolve();
    },
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  lease.free = 2;
  const ticking = leadership.tick();
  await entered.promise;
  const stopping = leadership.stop();
  gate.resolve();
  await ticking;
  await stopping;
  assertEquals(stoppedSeen, true);
  assertEquals(leadership.role, "follower");
  assertEquals(led, false);
});

Deno.test("ServeLeadership.stop: a stop while the leader record is written runs no promotion (swamp-club#4327)", async () => {
  const lease = new FakeLease();
  const store = memoryStore();
  const writing = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const put = store.put;
  store.put = async (key, value) => {
    writing.resolve();
    await gate.promise;
    return await put(key, value);
  };
  const events: string[] = [];
  const leadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store,
    refreshCopy: () => Promise.resolve(),
    onLead: () => {
      events.push("lead");
      return Promise.resolve();
    },
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  lease.free = 2;
  const ticking = leadership.tick();
  await writing.promise;
  const stopping = leadership.stop();
  gate.resolve();
  await ticking;
  await stopping;
  assertEquals(events, []);
  assertEquals(leadership.role, "follower");
});

Deno.test("ServeLeadership.stop: a follower stopped during its restore follows no feed after it (swamp-club#4327)", async () => {
  const lease = new FakeLease();
  const feed = new FakeFeed();
  const restoring = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let restores = 0;
  const leadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    feed,
    refreshCopy: async () => {
      restores++;
      restoring.resolve();
      await gate.promise;
    },
    onLead: () => Promise.resolve(),
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  const followedAtStart = feed.followed.length;
  const ticking = leadership.tick();
  await restoring.promise;
  const stopping = leadership.stop();
  gate.resolve();
  await ticking;
  await stopping;
  assertEquals(restores, 1);
  assertEquals(feed.followed.length, followedAtStart);
});

Deno.test("ServeLeadership.leadUnconfirmed: a leader whose lease the store has not confirmed is unconfirmed; a follower, or a lease that cannot tell, never is", async () => {
  const { lease, leadership } = setup();
  assertEquals(leadership.leadUnconfirmed(), false);
  lease.hold = { fence: 4, lost: false };
  await leadership.start("writer");
  try {
    // a lease without the check is taken as confirmed
    assertEquals(leadership.leadUnconfirmed(), false);
    let confirmed = false;
    (lease as LeadershipLease & { confirmed?: () => boolean }).confirmed = () =>
      confirmed;
    assertEquals(leadership.leadUnconfirmed(), true);
    confirmed = true;
    assertEquals(leadership.leadUnconfirmed(), false);
  } finally {
    await leadership.stop();
  }
});

/** a follower refresh that runs until its signal aborts it, as a long restore does */
function hangingRefresh() {
  const state = {
    calls: 0,
    aborted: 0,
    started: Promise.withResolvers<void>(),
  };
  const ended = Promise.withResolvers<void>();
  const refreshCopy = async (signal?: AbortSignal): Promise<void> => {
    state.calls++;
    state.started.resolve();
    const aborted = new Promise<void>((done) =>
      signal?.addEventListener("abort", () => done(), { once: true })
    );
    await Promise.race([aborted, ended.promise]);
    if (signal?.aborted === true) {
      state.aborted++;
      throw signal.reason;
    }
  };
  return { state, refreshCopy, end: () => ended.resolve() };
}

Deno.test("ServeLeadership: a follower's refresh still running when the holder's lease lapses runs to its end, and the lease is taken after it", async () => {
  const lease = new FakeLease();
  const feed = new FakeFeed();
  const refresh = hangingRefresh();
  const leadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    feed,
    refreshCopy: refresh.refreshCopy,
    onLead: () => Promise.resolve(),
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  try {
    const expiry = Date.now() + 100;
    lease.expiry = expiry;
    lease.freeFrom = { at: expiry, fence: 3 };
    const ticking = leadership.tick();
    await waitFor(() => Date.now() > expiry + 500, "the lease to lapse");
    assertEquals([refresh.state.calls, refresh.state.aborted], [1, 0]);
    assertEquals(lease.takes, 1);
    refresh.end();
    await ticking;
    assertEquals(leadership.role, "follower");
    await leadership.tick();
    assertEquals(leadership.role, "leader");
    assertEquals(lease.takes, 2);
  } finally {
    refresh.end();
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a follower tries the lease just after the holder's computed expiry when it comes before the next tick (swamp-club#4679)", async () => {
  const { lease, leadership } = setup();
  lease.expiry = Date.now() + 200;
  await leadership.start("follower");
  try {
    await waitFor(() => lease.takes >= 1, "a tick at the expiry", {
      timeoutMs: 5_000,
    });
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a lease that lapsed while a refresh ran is tried within the margin once it ends, not a whole tick later", async () => {
  const lease = new FakeLease();
  const refresh = hangingRefresh();
  const leadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    refreshCopy: refresh.refreshCopy,
    onLead: () => Promise.resolve(),
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  const expiry = Date.now() + 400;
  lease.expiry = expiry;
  lease.freeFrom = { at: expiry, fence: 3 };
  await leadership.start("follower");
  // a tick before the lapse: its take loses and its refresh outlasts the lapse
  const ticking = leadership.tick();
  try {
    await waitFor(() => refresh.state.calls === 1, "the refresh to start");
    assertEquals(lease.takes, 1);
    // past the tick scheduled at the expiry, which joins the one in flight
    await waitFor(() => Date.now() > expiry + 2_000, "the lease to lapse");
    refresh.end();
    await ticking;
    await waitFor(() => leadership.role === "leader", "the lease taken", {
      timeoutMs: 5_000,
    });
    assertEquals(lease.takes, 2);
  } finally {
    refresh.end();
    await leadership.stop();
  }
});

Deno.test("ServeLeadership: a follower ticks no slower than its tick when the holder's expiry is far off (swamp-club#4679)", async () => {
  const lease = new FakeLease();
  lease.expiry = Date.now() + 3_600_000;
  const leadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    refreshCopy: () => Promise.resolve(),
    onLead: () => Promise.resolve(),
    onLostLead: () => Promise.resolve(),
    tickMs: 50,
  });
  await leadership.start("follower");
  try {
    await waitFor(() => lease.takes >= 2, "two ticks at the tick interval");
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership.stop: aborts a follower refresh in flight rather than waiting it out (swamp-club#4679)", async () => {
  const lease = new FakeLease();
  const refresh = hangingRefresh();
  const leadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    refreshCopy: refresh.refreshCopy,
    onLead: () => Promise.resolve(),
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  let stopped = false;
  try {
    const ticking = leadership.tick();
    await refresh.state.started.promise;
    const stopping = leadership.stop().then(() => {
      stopped = true;
    });
    await waitFor(() => stopped, "stop to return", { timeoutMs: 5_000 });
    await stopping;
    await ticking;
    assertEquals(refresh.state.aborted, 1);
    assertEquals(lease.takes, 1, "no take after a stop");
  } finally {
    refresh.end();
    await leadership.stop();
  }
});

Deno.test("ServeLeadership.stop: still waits for a take() in flight (swamp-club#4679)", async () => {
  const lease = new FakeLease();
  const taking = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<"writer" | "follower">();
  lease.take = () => {
    lease.takes++;
    taking.resolve();
    return gate.promise;
  };
  const leadership = new ServeLeadership({
    instanceId: "me",
    lease,
    store: memoryStore(),
    refreshCopy: () => Promise.resolve(),
    onLead: () => Promise.resolve(),
    onLostLead: () => Promise.resolve(),
    tickMs: 3_600_000,
  });
  await leadership.start("follower");
  const ticking = leadership.tick();
  await taking.promise;
  let stopped = false;
  const stopping = leadership.stop().then(() => {
    stopped = true;
  });
  // lets stop() reach the take it must wait for
  await Promise.resolve();
  assert(!stopped, "stop waits for the take");
  gate.resolve("follower");
  await ticking;
  await stopping;
  assert(stopped);
});

function withLeaderRecord(
  store: ControlPlaneStore,
  instanceId: string,
  fence: number,
): Promise<void> {
  return store.put(
    SERVE_LEADER_KEY,
    serializeServeLeader({
      instanceId,
      fence,
      since: new Date().toISOString(),
    }),
  );
}

Deno.test("ServeLeadership.leaderGoing: a follower tries the lease every second until it takes it, not a tick later", async () => {
  const { lease, store, leadership } = setup();
  await withLeaderRecord(store, "old", 2);
  await leadership.start("follower");
  try {
    leadership.leaderGoing();
    assert(leadership.awaitingNewLeader);
    await waitFor(() => lease.takes >= 2, "two tries on the fast cadence", {
      timeoutMs: 10_000,
    });
    lease.free = 3;
    await waitFor(() => leadership.role === "leader", "the lease taken", {
      timeoutMs: 10_000,
    });
    assertEquals(leadership.awaitingNewLeader, false);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership.leaderGoing: a record naming a higher fence ends the wait", async () => {
  const { lease, store, leadership } = setup();
  await withLeaderRecord(store, "old", 2);
  await leadership.start("follower");
  try {
    leadership.leaderGoing();
    await leadership.tick();
    assert(leadership.awaitingNewLeader);
    await withLeaderRecord(store, "successor", 3);
    lease.current = 3;
    await leadership.tick();
    assertEquals(leadership.leader()?.instanceId, "successor");
    assertEquals(leadership.awaitingNewLeader, false);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership.leaderGoing: the wait ends on its own once the bound passes", async () => {
  let now = Date.now();
  const { store, leadership } = setup({ now: () => now });
  await withLeaderRecord(store, "old", 2);
  await leadership.start("follower");
  try {
    leadership.leaderGoing();
    assert(leadership.awaitingNewLeader);
    now += AWAIT_NEW_LEADER_MS;
    assertEquals(leadership.awaitingNewLeader, false);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership.leaderGoing: a leader ignores it", async () => {
  const { lease, leadership } = setup();
  lease.free = 1;
  await lease.take();
  await leadership.start("writer");
  try {
    leadership.leaderGoing();
    assertEquals(leadership.awaitingNewLeader, false);
  } finally {
    await leadership.stop();
  }
});

Deno.test("ServeLeadership.leaderGoing: a dropped feed back on the same leader was a blip and ends the wait; a stepping-down frame does not", async () => {
  for (
    const [after, waiting] of [["closed", false], ["frame", true]] as const
  ) {
    const feed = new FakeFeed();
    const { store, leadership } = setup({ feed });
    await withLeaderRecord(store, "old", 2);
    await leadership.start("follower");
    try {
      leadership.leaderGoing(after);
      feed.current_ = true;
      await leadership.tick();
      assertEquals(leadership.awaitingNewLeader, waiting);
    } finally {
      await leadership.stop();
    }
  }
});

Deno.test("ServeLeadership.leaderGoing: with no leader known, reading the old record does not end the wait", async () => {
  const { lease, store, leadership } = setup();
  await leadership.start("follower");
  try {
    leadership.leaderGoing("closed");
    await withLeaderRecord(store, "old", 2);
    lease.current = 2;
    await leadership.tick();
    assertEquals(leadership.leader()?.instanceId, "old");
    assertEquals(leadership.awaitingNewLeader, true);
  } finally {
    await leadership.stop();
  }
});
