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
import { sampleFingerprint } from "../../domain/serve/federation_test_helpers.ts";
import type { Fingerprint } from "../../domain/serve/fingerprint.ts";
import { InstanceId } from "../../domain/serve/instance_id.ts";
import { createTestHub } from "./federation_hub_test_helpers.ts";
import { HubSelfRecord } from "./hub_self_record.ts";

function hubFingerprint(settingsHash = "0".repeat(64)): Fingerprint {
  return sampleFingerprint({ federationRole: "hub", settingsHash });
}

Deno.test("HubSelfRecord: a node that never leads never writes the hub's record", async () => {
  const t = createTestHub();
  const queued: Array<() => void> = [];
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(hubFingerprint()),
  });
  record.start((start) => queued.push(start));
  await record.refresh();
  await record.settled();
  assertEquals(record.leading, false);
  assertEquals(t.members.raw("hub"), undefined);
  assertEquals(queued.length, 1);
});

Deno.test("HubSelfRecord: once leading it writes the record, and a reload rewrites it only on change", async () => {
  const t = createTestHub();
  let current = hubFingerprint();
  const queued: Array<() => void> = [];
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(current),
  });
  record.start((start) => queued.push(start));
  queued[0]();
  await record.settled();
  assertEquals(t.members.raw("hub")!.role, "hub");
  assertEquals(t.members.version("hub"), 1);
  await record.refresh();
  assertEquals(t.members.version("hub"), 1);
  current = hubFingerprint("1".repeat(64));
  await record.refresh();
  assertEquals(t.members.version("hub"), 2);
});

Deno.test("HubSelfRecord: a failed write is logged and the next refresh tries again", async () => {
  const t = createTestHub();
  let fail = true;
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () =>
      fail
        ? Promise.reject(new Error("vaults unreadable"))
        : Promise.resolve(hubFingerprint()),
  });
  record.start((start) => start());
  await record.settled();
  assertEquals(t.members.raw("hub"), undefined);
  fail = false;
  await record.refresh();
  assertEquals(t.members.version("hub"), 1);
});

const RUNNING = {
  team: { role: "leader" as const, nodes: 1 },
  startedAt: "2026-11-26T11:00:00.000Z",
  ready: true,
};

function selfSeenKeys(t: ReturnType<typeof createTestHub>): Promise<string[]> {
  return t.store.list("federation/seen/");
}

Deno.test("HubSelfRecord: the first beat runs after the first record write, so the hub is seen at once", async () => {
  const t = createTestHub();
  const instanceId = InstanceId.create(crypto.randomUUID());
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(hubFingerprint()),
    seen: {
      instanceId,
      runtime: () => Promise.resolve(RUNNING),
      intervalMs: 60 * 60 * 1000,
    },
  });
  record.start((start) => start());
  await record.settled();
  const hubId = t.members.raw("hub")!.memberId;
  assertEquals(await selfSeenKeys(t), [
    `federation/seen/${hubId}/${instanceId.value}`,
  ]);
  assertEquals(
    t.store.json(`federation/seen/${hubId}/${instanceId.value}`),
    { at: t.clock.now, runtime: RUNNING },
  );
  await record.stop();
});

Deno.test("HubSelfRecord: a beat moves the hub's last-seen time; a follower never beats", async () => {
  const t = createTestHub();
  const instanceId = InstanceId.create(crypto.randomUUID());
  const seen = {
    instanceId,
    runtime: () => Promise.resolve(RUNNING),
    intervalMs: 60 * 60 * 1000,
  };
  const follower = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(hubFingerprint()),
    seen,
  });
  follower.start(() => {});
  await follower.beat();
  assertEquals(await selfSeenKeys(t), []);
  await follower.stop();

  const leader = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(hubFingerprint()),
    seen,
  });
  leader.start((start) => start());
  await leader.settled();
  t.clock.now += 30_000;
  await leader.beat();
  const hubId = t.members.raw("hub")!.memberId;
  assertEquals(
    (t.store.json(`federation/seen/${hubId}/${instanceId.value}`) as {
      at: number;
    }).at,
    t.clock.now,
  );
  assertEquals(t.members.version("hub"), 1);
  await leader.stop();
});

Deno.test("HubSelfRecord: beats asked for while one is queued join it", async () => {
  const t = createTestHub();
  let reads = 0;
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(hubFingerprint()),
    seen: {
      instanceId: InstanceId.create(crypto.randomUUID()),
      runtime: () => {
        reads++;
        return Promise.resolve(RUNNING);
      },
      intervalMs: 60 * 60 * 1000,
    },
  });
  record.start((start) => start());
  await record.settled();
  reads = 0;
  const a = record.beat();
  const b = record.beat();
  assertEquals(a, b);
  await a;
  assertEquals(reads, 1);
  await record.stop();
});

Deno.test("HubSelfRecord: stop awaits a beat in flight and starts no more", async () => {
  const t = createTestHub();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let blocked = false;
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(hubFingerprint()),
    seen: {
      instanceId: InstanceId.create(crypto.randomUUID()),
      runtime: async () => {
        if (blocked) await gate;
        return RUNNING;
      },
      intervalMs: 60 * 60 * 1000,
    },
  });
  record.start((start) => start());
  await record.settled();
  blocked = true;
  t.clock.now += 30_000;
  const inFlight = record.beat();
  let stopped = false;
  const stopping = record.stop().then(() => stopped = true);
  await Promise.resolve();
  assertEquals(stopped, false);
  release();
  await inFlight;
  await stopping;
  assertEquals(stopped, true);
  const before = [...t.store.entries.keys()];
  await record.beat();
  await record.refresh();
  assertEquals([...t.store.entries.keys()], before);
});

Deno.test("HubSelfRecord: a failed beat is logged and the next beat writes", async () => {
  const t = createTestHub();
  let fail = true;
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(hubFingerprint()),
    seen: {
      instanceId: InstanceId.create(crypto.randomUUID()),
      runtime: () =>
        fail
          ? Promise.reject(new Error("team unreadable"))
          : Promise.resolve(RUNNING),
      intervalMs: 60 * 60 * 1000,
    },
  });
  record.start((start) => start());
  await record.settled();
  assertEquals(await selfSeenKeys(t), []);
  fail = false;
  await record.beat();
  assertEquals((await selfSeenKeys(t)).length, 1);
  await record.stop();
});
