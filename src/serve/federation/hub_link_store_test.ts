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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { HubLink, type HubLinkInstance } from "../../domain/serve/hub_link.ts";
import { MemoryControlPlaneStore } from "./federation_hub_test_helpers.ts";
import {
  HUB_LINK_INSTANCES_PREFIX,
  HUB_LINK_KEY,
  HubLinkStore,
  JOIN_CLAIM_KEY,
} from "./hub_link_store.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const MEMBER = {
  memberId: crypto.randomUUID(),
  memberName: "edge",
  hubName: "central",
  joinedAt: "2026-11-26T12:00:00.000Z",
};

function instance(
  instanceId: string,
  aliveAt: string,
): HubLinkInstance {
  return {
    instanceId,
    startedAt: aliveAt,
    aliveAt,
    lastAttemptAt: null,
    lastSuccessAt: null,
    result: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    stoppedAt: null,
  };
}

/** a store with no putIfAbsent, as some extension datastores are */
class PlainStore extends MemoryControlPlaneStore {
  declare putIfAbsent: undefined;
}

class AtomicStore extends MemoryControlPlaneStore {
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
    if (this.entries.has(key)) return Promise.resolve(false);
    this.entries.set(key, data);
    return Promise.resolve(true);
  }
}

Deno.test("HubLinkStore: an unwritten link is unjoined, and a written one reads back", async () => {
  const store = new MemoryControlPlaneStore();
  const links = new HubLinkStore(store);
  assertEquals((await links.readLink()).state, "unjoined");
  const link = HubLink.unjoined().beginJoin(
    "https://hub.example.com",
    crypto.randomUUID(),
  )
    .received(MEMBER).joined();
  await links.writeLink(link);
  assertEquals((await links.readLink()).toJSON(), link.toJSON());
  assert(store.entries.has(HUB_LINK_KEY));
});

Deno.test("HubLinkStore: a link record that does not parse rejects", async () => {
  const store = new MemoryControlPlaneStore();
  await store.put(HUB_LINK_KEY, new TextEncoder().encode('{"state":"x"}'));
  await assertRejects(() => new HubLinkStore(store).readLink());
});

Deno.test("HubLinkStore: instance keys are built only from a UUID", async () => {
  const links = new HubLinkStore(new MemoryControlPlaneStore());
  await assertRejects(
    () =>
      links.writeInstance(instance("../escape", "2026-11-26T12:00:00.000Z")),
  );
});

Deno.test("HubLinkStore: lists instances and prunes those unseen for 24 h, never its own", async () => {
  const store = new MemoryControlPlaneStore();
  const links = new HubLinkStore(store, () => NOW);
  await links.writeInstance(instance(A, "2026-11-24T12:00:00.000Z"));
  await links.writeInstance(instance(B, "2026-11-24T12:00:00.000Z"));
  const C = crypto.randomUUID();
  await links.writeInstance(instance(C, "2026-11-26T11:59:00.000Z"));
  assertEquals((await links.listInstances()).length, 3);
  assertEquals(await links.pruneInstances(A), 1);
  assertEquals(
    (await links.listInstances()).map((i) => i.instanceId).sort(),
    [A, C].sort(),
  );
});

Deno.test("HubLinkStore.claimJoin: one claim; another instance is refused until it is two minutes old", async () => {
  for (const store of [new AtomicStore(), new PlainStore()]) {
    let now = NOW;
    const links = new HubLinkStore(store, () => now);
    assertEquals(await links.claimJoin(A), true);
    assertEquals(await links.claimJoin(A), true);
    assertEquals(await links.claimJoin(B), false);
    now += 60_000;
    assertEquals(await links.claimJoin(B), false);
    now += 61_000;
    assertEquals(await links.claimJoin(B), true);
    assertEquals(await links.claimJoin(A), false);
  }
});

Deno.test("HubLinkStore.releaseJoin: releases only its own claim", async () => {
  const store = new AtomicStore();
  const links = new HubLinkStore(store, () => NOW);
  await links.claimJoin(A);
  await links.releaseJoin(B);
  assert(store.entries.has(JOIN_CLAIM_KEY));
  await links.releaseJoin(A);
  assert(!store.entries.has(JOIN_CLAIM_KEY));
});

Deno.test("HubLinkStore.clear: removes the link, every instance and the claim", async () => {
  const store = new AtomicStore();
  const links = new HubLinkStore(store, () => NOW);
  await links.writeLink(
    HubLink.unjoined().beginJoin(
      "https://hub.example.com",
      crypto.randomUUID(),
    ),
  );
  await links.writeInstance(instance(A, "2026-11-26T12:00:00.000Z"));
  await links.claimJoin(A);
  await links.clear();
  assertEquals(
    [...store.entries.keys()].filter((k) =>
      k === HUB_LINK_KEY || k.startsWith(HUB_LINK_INSTANCES_PREFIX) ||
      k === JOIN_CLAIM_KEY
    ),
    [],
  );
});
