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
import { hubTeamFacts } from "./hub_team.ts";

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

Deno.test("hubTeamFacts: outside a team the hub is one node on its own", async () => {
  assertEquals(
    await hubTeamFacts({ teamMode: false, following: () => true }),
    { role: "single", nodes: 1 },
  );
});

Deno.test("hubTeamFacts: in a team it counts nodes beating within the stale TTL, never a stopped one", async () => {
  const store = new MemoryControlPlaneStore();
  await beat(store, "a", 1_000);
  await beat(store, "b", 30_000);
  await beat(store, "c", 200_000);
  await beat(store, "d", 1_000, true);
  assertEquals(
    await hubTeamFacts({
      teamMode: true,
      following: () => false,
      heartbeats: store,
      staleTtlMs: 90_000,
      now: () => NOW,
    }),
    { role: "leader", nodes: 2 },
  );
  assertEquals(
    await hubTeamFacts({
      teamMode: true,
      following: () => true,
      heartbeats: new MemoryControlPlaneStore(),
      now: () => NOW,
    }),
    { role: "follower", nodes: 1 },
  );
});
