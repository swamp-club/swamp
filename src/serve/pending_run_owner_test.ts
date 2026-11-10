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
import { waitFor } from "@swamp-club/swamp-testing";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  DeferredReplaySweep,
  pendingOwnerLiveness,
} from "./pending_run_owner.ts";

const PEER = { instanceId: "peer", pid: 4242, host: "host-a" };

function storeWith(entries: Record<string, unknown>): ControlPlaneStore {
  const encoded = new Map(
    Object.entries(entries).map((
      [k, v],
    ) => [k, new TextEncoder().encode(JSON.stringify(v))]),
  );
  return {
    put: () => Promise.resolve(),
    get: (key: string) => Promise.resolve(encoded.get(key) ?? null),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  } as unknown as ControlPlaneStore;
}

function heartbeat(at: Date, stoppedAt?: Date) {
  return {
    instanceId: PEER.instanceId,
    hostname: "elsewhere",
    pid: PEER.pid,
    startedAt: at.toISOString(),
    heartbeatAt: at.toISOString(),
    ...(stoppedAt ? { stoppedAt: stoppedAt.toISOString() } : {}),
  };
}

const onHost = (host: string, gone: boolean) => ({
  hostIdentity: () => host,
  isGone: () => gone,
});

Deno.test("pendingOwnerLiveness: this process's own runs are always alive", async () => {
  const alive = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-a", true),
  });
  assertEquals(await alive({ instanceId: "self", pid: 1 }), true);
});

Deno.test("pendingOwnerLiveness: a peer on this host is judged by its process", async () => {
  const live = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-a", false),
  });
  const gone = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-a", true),
  });
  assertEquals(await live(PEER), true);
  assertEquals(await gone(PEER), false);
});

Deno.test("pendingOwnerLiveness: a peer elsewhere is alive while its heartbeat is fresh", async () => {
  const now = new Date();
  const fresh = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-b", true),
    controlPlaneStore: storeWith({ "heartbeats/peer": heartbeat(now) }),
    staleTtlMs: 90_000,
  });
  const stale = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-b", true),
    controlPlaneStore: storeWith({
      "heartbeats/peer": heartbeat(new Date(now.getTime() - 600_000)),
    }),
    staleTtlMs: 90_000,
  });
  const stopped = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-b", true),
    controlPlaneStore: storeWith({ "heartbeats/peer": heartbeat(now, now) }),
  });
  const missing = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-b", true),
    controlPlaneStore: storeWith({}),
  });
  const noStore = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-b", true),
  });
  assertEquals(await fresh(PEER), true);
  assertEquals(await stale(PEER), false);
  assertEquals(await stopped(PEER), false);
  assertEquals(await missing(PEER), false);
  assertEquals(await noStore(PEER), false);
});

Deno.test("pendingOwnerLiveness: an owner with no host is judged by its heartbeat", async () => {
  const alive = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-a", true),
    controlPlaneStore: storeWith({ "heartbeats/peer": heartbeat(new Date()) }),
  });
  assertEquals(await alive({ instanceId: "peer", pid: 4242 }), true);
});

Deno.test("DeferredReplaySweep: passes until nothing is left deferred, then stops on its own", async () => {
  const passes: string[][] = [];
  let ownerGone = false;
  const sweep = new DeferredReplaySweep({
    intervalMs: 1,
    replay: (ids) => {
      passes.push([...ids]);
      return Promise.resolve(ownerGone ? new Set<string>() : new Set(ids));
    },
  });
  sweep.start(new Set(["a", "b"]));
  await waitFor(() => passes.length >= 2, "two passes while the owner lives");
  ownerGone = true;
  await waitFor(() => sweep.pending.size === 0, "the sweep emptied");
  const settled = passes.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(passes.length, settled);
  assertEquals(passes[0], ["a", "b"]);
  await sweep.stop();
});

Deno.test("DeferredReplaySweep: stop waits for a pass in flight and schedules no more", async () => {
  const gate = Promise.withResolvers<void>();
  let passes = 0;
  let finished = false;
  const sweep = new DeferredReplaySweep({
    intervalMs: 1,
    replay: async (ids) => {
      passes++;
      await gate.promise;
      finished = true;
      return new Set(ids);
    },
  });
  sweep.start(new Set(["a"]));
  await waitFor(() => passes === 1, "a pass started");
  const stopping = sweep.stop();
  gate.resolve();
  await stopping;
  assertEquals(finished, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(passes, 1);
});

Deno.test("DeferredReplaySweep: a later start adds to what it waits on", async () => {
  const seen: string[][] = [];
  const sweep = new DeferredReplaySweep({
    intervalMs: 1,
    replay: (ids) => {
      seen.push([...ids].sort());
      return Promise.resolve(new Set<string>());
    },
  });
  sweep.start(new Set(["a"]));
  sweep.start(new Set(["b"]));
  await waitFor(() => seen.length >= 1, "a pass ran");
  assertEquals(seen[0], ["a", "b"]);
  await sweep.stop();
});
