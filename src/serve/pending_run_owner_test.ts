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
  pendingOwnerLiveness,
  PendingReplaySweep,
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

Deno.test("pendingOwnerLiveness: an earlier process with this process's pid on this host is gone", async () => {
  const alive = pendingOwnerLiveness({
    instanceId: "self",
    ownPid: PEER.pid,
    ...onHost("host-a", false),
  });
  assertEquals(await alive(PEER), false);
});

Deno.test("pendingOwnerLiveness: an owner with no host is judged by its heartbeat", async () => {
  const alive = pendingOwnerLiveness({
    instanceId: "self",
    ...onHost("host-a", true),
    controlPlaneStore: storeWith({ "heartbeats/peer": heartbeat(new Date()) }),
  });
  assertEquals(await alive({ instanceId: "peer", pid: 4242 }), true);
});

function manualTimer() {
  const queued: (() => void)[] = [];
  return {
    schedule: (run: () => void) => queued.push(run),
    cancel: () => queued.splice(0),
    queued,
    fire: () => queued.shift()?.(),
  };
}

Deno.test("PendingReplaySweep: passes again after each pass until stopped", async () => {
  const timer = manualTimer();
  let passes = 0;
  const sweep = new PendingReplaySweep({
    replay: () => {
      passes++;
      return Promise.resolve();
    },
    schedule: timer.schedule,
    cancel: timer.cancel,
  });
  sweep.start();
  sweep.start();
  assertEquals(timer.queued.length, 1);
  timer.fire();
  await waitFor(() => timer.queued.length === 1, "the next pass scheduled");
  timer.fire();
  await waitFor(() => passes === 2, "two passes ran");
  await sweep.stop();
  assertEquals(timer.queued.length, 0);
});

Deno.test("PendingReplaySweep: a pass that throws does not end the sweep", async () => {
  const timer = manualTimer();
  let passes = 0;
  const sweep = new PendingReplaySweep({
    replay: () => {
      passes++;
      return Promise.reject(new Error("database is locked"));
    },
    schedule: timer.schedule,
    cancel: timer.cancel,
  });
  sweep.start();
  timer.fire();
  await waitFor(() => timer.queued.length === 1, "rescheduled after a failure");
  assertEquals(passes, 1);
  await sweep.stop();
});

Deno.test("PendingReplaySweep: stop waits for a pass in flight and schedules no more", async () => {
  const timer = manualTimer();
  const gate = Promise.withResolvers<void>();
  let finished = false;
  const sweep = new PendingReplaySweep({
    replay: async () => {
      await gate.promise;
      finished = true;
    },
    schedule: timer.schedule,
    cancel: timer.cancel,
  });
  sweep.start();
  timer.fire();
  const stopping = sweep.stop();
  gate.resolve();
  await stopping;
  assertEquals(finished, true);
  assertEquals(timer.queued.length, 0);
});
