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
import { MemoryControlPlaneStore } from "./federation_hub_test_helpers.ts";
import { serveTeamFacts, serveTeamMode } from "./serve_team.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");

async function beat(
  store: MemoryControlPlaneStore,
  instanceId: string,
  ageMs: number,
  stopped = false,
): Promise<void> {
  const at = new Date(NOW - ageMs).toISOString();
  await store.put(
    `heartbeats/${instanceId}`,
    new TextEncoder().encode(JSON.stringify({
      instanceId,
      hostname: "node",
      pid: 1,
      startedAt: at,
      heartbeatAt: at,
      ...(stopped ? { stoppedAt: at } : {}),
    })),
  );
}

async function teamOfFour(): Promise<MemoryControlPlaneStore> {
  const store = new MemoryControlPlaneStore();
  await beat(store, "a", 1_000);
  await beat(store, "b", 30_000);
  await beat(store, "c", 200_000);
  await beat(store, "d", 1_000, true);
  return store;
}

Deno.test("serveTeamMode: v3 is a team, a v2 remote control plane is shared, anything else is local", () => {
  assertEquals(serveTeamMode({ v3: true, hasRemoteControlPlane: true }), "v3");
  assertEquals(
    serveTeamMode({ v3: false, hasRemoteControlPlane: true }),
    "v2-shared",
  );
  assertEquals(
    serveTeamMode({ v3: false, hasRemoteControlPlane: false }),
    "local",
  );
});

Deno.test("serveTeamFacts: a local serve is one node on its own", async () => {
  assertEquals(
    await serveTeamFacts({
      mode: "local",
      following: () => true,
      heartbeats: await teamOfFour(),
      now: () => NOW,
    }),
    { role: "single", nodes: 1 },
  );
});

Deno.test("serveTeamFacts: in a v3 team it counts nodes beating within the stale TTL, never a stopped one", async () => {
  assertEquals(
    await serveTeamFacts({
      mode: "v3",
      following: () => false,
      heartbeats: await teamOfFour(),
      staleTtlMs: 90_000,
      now: () => NOW,
    }),
    { role: "leader", nodes: 2 },
  );
  assertEquals(
    await serveTeamFacts({
      mode: "v3",
      following: () => true,
      heartbeats: new MemoryControlPlaneStore(),
      now: () => NOW,
    }),
    { role: "follower", nodes: 1 },
  );
});

Deno.test("serveTeamFacts: v2 serves sharing a control plane are peers counted from live heartbeats", async () => {
  assertEquals(
    await serveTeamFacts({
      mode: "v2-shared",
      following: () => false,
      heartbeats: await teamOfFour(),
      staleTtlMs: 90_000,
      now: () => NOW,
    }),
    { role: "peer", nodes: 2 },
  );
});

Deno.test("serveTeamFacts: a v2 serve alone on a shared control plane is single", async () => {
  const store = new MemoryControlPlaneStore();
  await beat(store, "a", 1_000);
  assertEquals(
    await serveTeamFacts({
      mode: "v2-shared",
      following: () => false,
      heartbeats: store,
      now: () => NOW,
    }),
    { role: "single", nodes: 1 },
  );
});
