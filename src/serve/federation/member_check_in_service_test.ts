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
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import { HUB_LINK_KEY, JOIN_CLAIM_KEY } from "./hub_link_store.ts";
import {
  MAX_JOIN_TOKEN_BYTES,
  readJoinTokenFile,
} from "./member_check_in_service.ts";
import {
  AtomicMemoryStore,
  FakeHub,
  type MemberNode,
  memberNode,
} from "./member_check_in_test_helpers.ts";

function fastHub(): FakeHub {
  const hub = new FakeHub();
  hub.intervalSeconds = 0.01;
  return hub;
}

async function instanceOf(node: MemberNode) {
  return await node.links.readInstance(node.instanceId);
}

/** liveness ticks are this test's clock: progress without a fixed sleep */
async function ticks(node: MemberNode, count: number): Promise<void> {
  let seen = 0;
  let last = (await instanceOf(node))?.aliveAt;
  await waitFor(async () => {
    const aliveAt = (await instanceOf(node))?.aliveAt;
    if (aliveAt !== last) {
      seen++;
      last = aliveAt;
    }
    return seen >= count;
  }, `${count} liveness ticks`);
}

Deno.test("MemberCheckInService: joins with the token, keeps the credential in the vault and checks in straight away", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  node.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 2, "two check-ins");
    const link = await node.links.readLink();
    assertEquals(link.state, "joined");
    assertEquals(link.hubName, "central");
    assertEquals(hub.joins.length, 1);
    const credential = await node.credentials.read();
    assertEquals(credential?.memberId, link.memberId);
    assertEquals(hub.checkIns[0], {
      memberId: link.memberId!,
      instanceId: node.instanceId,
    });
    const instance = await instanceOf(node);
    assertEquals(instance?.result, "ok");
    assertEquals(instance?.consecutiveFailures, 0);
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: start returns before the hub answers", async () => {
  const store = new AtomicMemoryStore();
  const node = await memberNode(store, fastHub(), { token: "t" });
  node.service.start();
  await node.service.stop();
});

Deno.test("MemberCheckInService: the next check-in follows the hub's interval", async () => {
  const store = new AtomicMemoryStore();
  const hub = new FakeHub();
  hub.intervalSeconds = 120;
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  node.service.start();
  try {
    await waitFor(
      async () => (await instanceOf(node))?.result === "ok",
      "a check-in",
    );
    const instance = (await instanceOf(node))!;
    assertEquals(
      Date.parse(instance.nextAttemptAt!) - Date.parse(instance.lastAttemptAt!),
      120_000,
    );
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a hub that is down is retried with growing backoff, then check-ins resume", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  for (let i = 0; i < 4; i++) {
    hub.scriptedCheckIns.push({ kind: "unreachable" });
  }
  node.service.start();
  try {
    await waitFor(
      async () => (await instanceOf(node))?.consecutiveFailures === 3,
      "three failures",
    );
    assertEquals((await instanceOf(node))?.result, "unreachable");
    await waitFor(
      async () => (await instanceOf(node))?.result === "ok",
      "a check-in again",
    );
    assertEquals((await instanceOf(node))?.consecutiveFailures, 0);
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a 401 on check-in refuses the link, forgets the credential and stops", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  node.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    const memberId = (await node.links.readLink()).memberId!;
    hub.removed.add(memberId);
    await waitFor(
      async () => (await instanceOf(node))?.result === "refused",
      "the refusal recorded",
    );
    assertEquals((await node.links.readLink()).state, "refused");
    assertEquals(await node.credentials.read(), undefined);
    const calls = hub.checkIns.length;
    await ticks(node, 3);
    assertEquals(hub.checkIns.length, calls);
    assertEquals((await instanceOf(node))?.result, "refused");
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a 401 for an old credential leaves a newer member's link alone", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  node.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    const old = await node.credentials.read();
    const newer = MemberCredential.issue(crypto.randomUUID());
    // another process rejoins, as a restart with a new token after removal does,
    // while this one is mid check-in with the old credential
    hub.beforeCheckIn = async () => {
      await node.links.writeLink(
        (await node.links.readLink()).refuse().beginJoin(
          "https://hub.example.com",
          crypto.randomUUID(),
        ).received({
          memberId: newer.memberId,
          memberName: "edge",
          hubName: "central",
          joinedAt: new Date().toISOString(),
        }).joined(),
      );
      await node.credentials.store(newer);
    };
    hub.removed.add(old!.memberId);
    await waitFor(
      async () => (await instanceOf(node))?.result === "refused",
      "the old credential refused",
    );
    const link = await node.links.readLink();
    assertEquals(link.state, "joined");
    assertEquals(link.memberId, newer.memberId);
    assertEquals((await node.credentials.read())?.toWire(), newer.toWire());
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a control plane that fails for a while never ends the loop; check-ins resume", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  node.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    const put = store.put.bind(store);
    const get = store.get.bind(store);
    let failing = true;
    let refused = 0;
    store.put = (key, data) => {
      if (failing) {
        refused++;
        return Promise.reject(new Error("control plane down"));
      }
      return put(key, data);
    };
    store.get = (key) =>
      failing ? Promise.reject(new Error("control plane down")) : get(key);
    await waitFor(() => refused >= 4, "several refused writes");
    failing = false;
    const calls = hub.checkIns.length;
    await waitFor(() => hub.checkIns.length > calls + 2, "check-ins resuming");
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a credential write that fails after the hub accepted the join is retried, not lost", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  const put = store.put.bind(store);
  let failures = 2;
  store.put = (key, data) => {
    if (key.startsWith("token-secrets/values/") && failures > 0) {
      failures--;
      return Promise.reject(new Error("vault write failed"));
    }
    return put(key, data);
  };
  node.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    assertEquals(hub.joins.length, 1);
    assertEquals((await node.links.readLink()).state, "joined");
    assert((await node.credentials.read()) !== undefined);
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a join refused because another node spent the token meanwhile checks in as that member", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: "edge.spent" });
  const winner = MemberCredential.issue(crypto.randomUUID());
  hub.scriptedJoins.push({ kind: "unauthorized" });
  const links = node.links;
  const before = links.writeLink.bind(links);
  let joiningWritten = false;
  // the other node's join lands while this one's is in flight
  links.writeLink = async (link) => {
    await before(link);
    if (link.state === "joining" && !joiningWritten) {
      joiningWritten = true;
      await before(
        link.received({
          memberId: winner.memberId,
          memberName: "edge",
          hubName: "central",
          joinedAt: new Date().toISOString(),
        }).joined(),
      );
      await node.credentials.store(winner);
    }
  };
  node.service.start();
  try {
    await waitFor(
      () => hub.checkIns.some((c) => c.memberId === winner.memberId),
      "a check-in as the other node's member",
    );
    const link = await links.readLink();
    assertEquals(link.state, "joined");
    assertEquals(link.memberId, winner.memberId);
    assert((await instanceOf(node))?.result !== "join_refused");
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a link write that fails right after the hub accepted the join is retried", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  const put = store.put.bind(store);
  let linkWrites = 0;
  store.put = (key, data) => {
    // the first write is the joining record; the next two, the reply, fail
    if (key === HUB_LINK_KEY && ++linkWrites >= 2 && linkWrites <= 3) {
      return Promise.reject(new Error("store hiccup"));
    }
    return put(key, data);
  };
  node.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    assertEquals(hub.joins.length, 1);
    assertEquals((await node.links.readLink()).state, "joined");
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a shutdown during a join still keeps the credential the hub issued", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  const put = store.put.bind(store);
  let failCredential = true;
  store.put = (key, data) => {
    if (key.startsWith("token-secrets/values/") && failCredential) {
      failCredential = false;
      return Promise.reject(new Error("vault write failed"));
    }
    return put(key, data);
  };
  let stopping: Promise<void> | undefined;
  hub.beforeJoin = () => {
    stopping = node.service.stop();
  };
  node.service.start();
  await waitFor(() => stopping !== undefined, "the shutdown");
  await stopping;
  assertEquals((await node.links.readLink()).state, "joined");
  assert((await node.credentials.read()) !== undefined);
  assertEquals(hub.checkIns.length, 0);
});

Deno.test("MemberCheckInService: a refused join token is logged once and not retried", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: "edge.unknown" });
  node.service.start();
  try {
    await waitFor(
      async () => (await instanceOf(node))?.result === "join_refused",
      "join refused",
    );
    await ticks(node, 3);
    assertEquals(hub.joins.length, 1);
    assertEquals((await node.links.readLink()).state, "unjoined");
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: without a join-token-file an unjoined member makes no request", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, {});
  node.service.start();
  try {
    await ticks(node, 3);
    assertEquals(hub.joins.length, 0);
    assertEquals(hub.checkIns.length, 0);
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a restarted member checks in as the same member with no token", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const first = await memberNode(store, hub, { token: hub.mintToken() });
  first.service.start();
  await waitFor(() => hub.checkIns.length >= 1, "a check-in");
  const memberId = (await first.links.readLink()).memberId;
  await first.service.stop();
  const rebuilt = await memberNode(store, hub, {});
  rebuilt.service.start();
  try {
    await waitFor(
      () => hub.checkIns.some((c) => c.instanceId === rebuilt.instanceId),
      "the rebuilt instance's check-in",
    );
    assertEquals(hub.joins.length, 1);
    assertEquals(
      hub.checkIns.find((c) => c.instanceId === rebuilt.instanceId)?.memberId,
      memberId,
    );
  } finally {
    await rebuilt.service.stop();
  }
});

Deno.test("MemberCheckInService: a different hub URL from the joined one makes no request and marks the link mismatched", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const first = await memberNode(store, hub, { token: hub.mintToken() });
  first.service.start();
  await waitFor(() => hub.checkIns.length >= 1, "a check-in");
  await first.service.stop();
  const calls = hub.checkIns.length;
  const moved = await memberNode(store, hub, {
    hubUrl: "https://other.example.com",
    token: hub.mintToken(),
  });
  moved.service.start();
  try {
    await waitFor(
      async () => (await moved.links.readLink()).state === "mismatched",
      "mismatched",
    );
    await ticks(moved, 3);
    assertEquals(hub.checkIns.length, calls);
    assertEquals(hub.joins.length, 1);
    assert((await moved.credentials.read()) !== undefined);
  } finally {
    await moved.service.stop();
  }
});

Deno.test("MemberCheckInService: two instances on one store join once and check in as two instances of one member", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const token = hub.mintToken();
  const a = await memberNode(store, hub, { token });
  const b = await memberNode(store, hub, { token });
  a.service.start();
  b.service.start();
  try {
    await waitFor(
      () =>
        hub.checkIns.some((c) => c.instanceId === a.instanceId) &&
        hub.checkIns.some((c) => c.instanceId === b.instanceId),
      "both instances checking in",
    );
    assertEquals(hub.joins.length, 1);
    assertEquals(new Set(hub.checkIns.map((c) => c.memberId)).size, 1);
  } finally {
    await a.service.stop();
    await b.service.stop();
  }
});

Deno.test("MemberCheckInService: stop marks its instance stopped and keeps every other running", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  node.service.start();
  await waitFor(() => hub.checkIns.length >= 1, "a check-in");
  await node.service.stop();
  assert((await instanceOf(node))?.stoppedAt !== null);
  assertEquals(hub.disposed, 1);
});

Deno.test("MemberCheckInService: a store that fails never rejects into serve", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  let reads = 0;
  store.get = () => {
    reads++;
    return Promise.reject(new Error("control plane down"));
  };
  store.put = () => Promise.reject(new Error("control plane down"));
  node.service.start();
  await waitFor(() => reads > 0, "the service reaching its store");
  await node.service.stop();
  assertEquals(hub.joins.length, 0);
  assert(!store.entries.has(HUB_LINK_KEY));
});

Deno.test("readJoinTokenFile: trims the token and refuses a missing, empty or oversized file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token");
    assertEquals(await readJoinTokenFile(path), undefined);
    await Deno.writeTextFile(path, "  edge.secret\n");
    assertEquals(await readJoinTokenFile(path), "edge.secret");
    await Deno.writeTextFile(path, "\n");
    assertEquals(await readJoinTokenFile(path), undefined);
    await Deno.writeTextFile(path, "x".repeat(MAX_JOIN_TOKEN_BYTES + 1));
    assertEquals(await readJoinTokenFile(path), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("MemberCheckInService: the joinId is stored before the join request leaves", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  let storedAtRequest: string | null | undefined;
  hub.beforeJoin = () => {
    const bytes = store.entries.get(HUB_LINK_KEY);
    storedAtRequest = bytes === undefined
      ? undefined
      : JSON.parse(new TextDecoder().decode(bytes)).joinId;
  };
  node.service.start();
  try {
    await waitFor(
      async () => (await node.links.readLink()).joinId === null,
      "the first check-in confirms the join",
    );
    assertEquals(storedAtRequest, hub.joinIds[0]);
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: a lost join reply is replayed with the same joinId and joins as one member", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  hub.dropReplies = 2;
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  node.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    assertEquals(hub.joins.length, 3);
    assertEquals(new Set(hub.joinIds).size, 1);
    const link = await node.links.readLink();
    assertEquals(link.state, "joined");
    assertEquals(
      new Set(hub.checkIns.map((c) => c.memberId)),
      new Set([link.memberId!]),
    );
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: shutdown mid-join keeps the joinId, and the next start replays it", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const token = hub.mintToken();
  hub.dropReplies = 1;
  const first = await memberNode(store, hub, { token });
  first.service.start();
  await waitFor(() => hub.joins.length >= 1, "a join");
  await first.service.stop();
  const left = await first.links.readLink();
  assertEquals(left.state, "joining");
  assertEquals(left.joinId, hub.joinIds[0]);

  const second = await memberNode(store, hub, { token });
  second.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    assertEquals(new Set(hub.joinIds).size, 1);
    assertEquals((await second.links.readLink()).state, "joined");
  } finally {
    await second.service.stop();
  }
});

Deno.test("MemberCheckInService: a node taking over the join replays the joinId already in the shared link", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const token = hub.mintToken();
  hub.dropReplies = 1;
  const first = await memberNode(store, hub, { token });
  first.service.start();
  await waitFor(() => hub.joins.length >= 1, "a join");
  await first.service.stop();
  const second = await memberNode(store, hub, { token });
  second.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    assertEquals(hub.joinIds.length >= 2, true);
    assertEquals(new Set(hub.joinIds).size, 1);
  } finally {
    await second.service.stop();
  }
});

Deno.test("MemberCheckInService: a refused replay ends unjoined after one attempt, even with a recorded reply", async () => {
  for (const recorded of [false, true]) {
    const store = new AtomicMemoryStore();
    const hub = fastHub();
    const links = (await memberNode(store, hub)).links;
    let joining = (await links.readLink()).beginJoin(
      "https://hub.example.com",
      crypto.randomUUID(),
    );
    if (recorded) {
      joining = joining.received({
        memberId: crypto.randomUUID(),
        memberName: "edge",
        hubName: "central",
        joinedAt: new Date().toISOString(),
      });
    }
    await links.writeLink(joining);
    const node = await memberNode(store, hub, { token: "edge.expired" });
    node.service.start();
    try {
      await waitFor(
        async () => (await instanceOf(node))?.result === "join_refused",
        "join refused",
      );
      await ticks(node, 3);
      assertEquals(hub.joins.length, 1);
      assertEquals(hub.joinIds[0], joining.joinId);
      const link = await node.links.readLink();
      assertEquals(link.state, "unjoined");
      assertEquals(link.joinId, null);
    } finally {
      await node.service.stop();
    }
  }
});

Deno.test("MemberCheckInService: a 409 on join abandons the joinId", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  hub.scriptedJoins.push({ kind: "conflict", error: "name_taken" });
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  node.service.start();
  try {
    await waitFor(
      async () => (await instanceOf(node))?.result === "name_taken",
      "name taken",
    );
    assertEquals((await node.links.readLink()).state, "unjoined");
  } finally {
    await node.service.stop();
  }
});

Deno.test("MemberCheckInService: neither the token nor the joinId reaches a log line", async () => {
  const records: string[] = [];
  await configure({
    sinks: {
      capture: (record: LogRecord) => records.push(JSON.stringify(record)),
    },
    loggers: [{
      category: ["serve"],
      lowestLevel: "debug",
      sinks: ["capture"],
    }],
    reset: true,
  });
  try {
    const store = new AtomicMemoryStore();
    const hub = fastHub();
    hub.dropReplies = 1;
    const token = hub.mintToken();
    const node = await memberNode(store, hub, { token });
    node.service.start();
    try {
      await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    } finally {
      await node.service.stop();
    }
    const text = records.join("\n");
    assert(text.includes("retrying the same join"));
    assert(!text.includes(hub.joinIds[0]));
    assert(!text.includes(token));
  } finally {
    await reset();
  }
});

function staleClaim(store: AtomicMemoryStore): void {
  store.entries.set(
    JOIN_CLAIM_KEY,
    new TextEncoder().encode(JSON.stringify({
      instanceId: crypto.randomUUID(),
      claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    })),
  );
}

Deno.test("MemberCheckInService: a node that stalls and stores a credential the hub replaced heals with one replay, and both nodes keep checking in", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  hub.rotateCredentials = true;
  const token = hub.mintToken();
  const a = await memberNode(store, hub, { token });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let stalled = false;
  const store_ = a.credentials.store.bind(a.credentials);
  a.credentials.store = async (credential) => {
    if (!stalled) {
      stalled = true;
      await gate;
    }
    await store_(credential);
  };
  a.service.start();
  const b = await memberNode(store, hub, { token });
  try {
    await waitFor(() => stalled, "node A stalls before storing its credential");
    // node A held the claim past its timeout
    staleClaim(store);
    b.service.start();
    await waitFor(
      async () => (await b.links.readLink()).joinId === null,
      "node B replays the join and confirms it",
    );
    assertEquals(hub.joins.length, 2);
    release();
    const checkInsOf = (node: MemberNode) =>
      hub.checkIns.filter((c) => c.instanceId === node.instanceId).length;
    const before = { a: checkInsOf(a), b: checkInsOf(b) };
    await waitFor(
      () => checkInsOf(a) > before.a + 2 && checkInsOf(b) > before.b + 2,
      "both nodes check in again",
    );
    assertEquals(hub.joins.length, 3);
    const link = await a.links.readLink();
    assertEquals(link.state, "joined");
    await waitFor(
      async () => (await a.links.readLink()).joinId === null,
      "the healed join is confirmed",
    );
    assert((await instanceOf(a))?.result !== "refused");
    assert((await instanceOf(b))?.result !== "refused");
  } finally {
    release();
    await a.service.stop();
    await b.service.stop();
  }
});

Deno.test("MemberCheckInService: two nodes taking over one stale claim leave one joiner and no refusal", async () => {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [{
      category: ["serve"],
      lowestLevel: "debug",
      sinks: ["capture"],
    }],
    reset: true,
  });
  try {
    const store = new AtomicMemoryStore();
    staleClaim(store);
    // both nodes judge the claim stale; the second goes on only once the first
    // has replaced it, as a node that stalled between its steps would
    let reads = 0;
    let bothRead!: () => void;
    const bothHaveRead = new Promise<void>((resolve) => bothRead = resolve);
    let replaced!: () => void;
    const firstReplaced = new Promise<void>((resolve) => replaced = resolve);
    const get = store.get.bind(store);
    store.get = async (key: string) => {
      const value = await get(key);
      if (key !== JOIN_CLAIM_KEY || reads >= 2) return value;
      reads++;
      if (reads === 1) {
        await bothHaveRead;
      } else {
        bothRead();
        await firstReplaced;
      }
      return value;
    };
    const putIfAbsent = store.putIfAbsent.bind(store);
    store.putIfAbsent = async (key: string, data: Uint8Array) => {
      const created = await putIfAbsent(key, data);
      if (key === JOIN_CLAIM_KEY && created && reads === 2) replaced();
      return created;
    };
    const hub = fastHub();
    const token = hub.mintToken();
    const a = await memberNode(store, hub, { token });
    const b = await memberNode(store, hub, { token });
    a.service.start();
    b.service.start();
    try {
      await waitFor(
        () => new Set(hub.checkIns.map((c) => c.instanceId)).size === 2,
        "both nodes check in",
      );
      assertEquals(hub.joins.length, 1);
      assertEquals(
        records.filter((r) => r.level === "error").length,
        0,
        records.map((r) => r.message.join("")).join("\n"),
      );
    } finally {
      await a.service.stop();
      await b.service.stop();
    }
  } finally {
    await reset();
  }
});

Deno.test("MemberCheckInService: a refusal waits for the join claim before deleting anything", async () => {
  const store = new AtomicMemoryStore();
  const hub = fastHub();
  const node = await memberNode(store, hub, { token: hub.mintToken() });
  node.service.start();
  try {
    await waitFor(() => hub.checkIns.length >= 1, "a check-in");
    // another node is joining: it holds a fresh claim
    store.entries.set(
      JOIN_CLAIM_KEY,
      new TextEncoder().encode(JSON.stringify({
        instanceId: crypto.randomUUID(),
        claimedAt: new Date().toISOString(),
      })),
    );
    const memberId = (await node.links.readLink()).memberId!;
    hub.removed.add(memberId);
    await waitFor(
      async () => (await instanceOf(node))?.result === "waiting",
      "the refusal waits for the claim",
    );
    assertEquals((await node.links.readLink()).state, "joined");
    assert(await node.credentials.read() !== undefined);
    store.entries.delete(JOIN_CLAIM_KEY);
    await waitFor(
      async () => (await instanceOf(node))?.result === "refused",
      "the refusal lands once the claim is free",
    );
    assertEquals((await node.links.readLink()).state, "refused");
    assertEquals(await node.credentials.read(), undefined);
  } finally {
    await node.service.stop();
  }
});
