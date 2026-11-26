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
import { InstanceId } from "../../domain/serve/instance_id.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import {
  INSTANCE_TTL_MS,
  OFFLINE_AFTER_MS,
  STALE_AFTER_MS,
} from "../../domain/serve/serve_member.ts";
import type { SweepReport } from "./federation_hub.ts";
import { createTestHub, type TestHub } from "./federation_hub_test_helpers.ts";
import { MemberStatusSweeper } from "./member_status_sweeper.ts";

async function joinAndCheckIn(t: TestHub, name = "edge-1") {
  const { plaintext } = await t.hub.createToken(name);
  const joined = await t.hub.join(plaintext, sampleFingerprint());
  if (joined.kind !== "joined") throw new Error(joined.kind);
  const credential = MemberCredential.parse(joined.credential);
  const instance = InstanceId.create(crypto.randomUUID());
  await t.hub.checkIn(credential, instance, sampleFingerprint());
  return { credential, instance, memberId: joined.memberId };
}

Deno.test("MemberStatusSweeper: marks stale then offline from the last check-in, writing only on change", async () => {
  const t = createTestHub();
  const { credential, instance } = await joinAndCheckIn(t);
  const sweeper = new MemberStatusSweeper({ hub: t.hub });
  const versionAfterCheckIn = t.members.version("edge-1");

  t.clock.now += STALE_AFTER_MS - 1;
  await sweeper.tick();
  assertEquals(t.members.raw("edge-1")!.status, "online");
  assertEquals(t.members.version("edge-1"), versionAfterCheckIn);

  t.clock.now += 1;
  assertEquals((await sweeper.tick())?.membersWritten, 1);
  assertEquals(t.members.raw("edge-1")!.status, "stale");
  assertEquals((await sweeper.tick())?.membersWritten, 0);

  t.clock.now += OFFLINE_AFTER_MS;
  await sweeper.tick();
  assertEquals(t.members.raw("edge-1")!.status, "offline");

  await t.hub.checkIn(credential, instance, sampleFingerprint());
  assertEquals(t.members.raw("edge-1")!.status, "online");
  await sweeper.stop();
});

Deno.test("MemberStatusSweeper: prunes an instance and its seen key after the instance TTL", async () => {
  const t = createTestHub();
  const { instance, memberId } = await joinAndCheckIn(t);
  const key = `federation/seen/${memberId}/${instance.value}`;
  const sweeper = new MemberStatusSweeper({ hub: t.hub });
  t.clock.now += INSTANCE_TTL_MS;
  const report = await sweeper.tick();
  assertEquals(report?.seenKeysDeleted, 1);
  assertEquals(t.store.entries.has(key), false);
  const record = t.members.raw("edge-1")!;
  assertEquals(record.instances, []);
  assertEquals(record.status, "offline");
  await sweeper.stop();
});

Deno.test("MemberStatusSweeper: drops a removed member's seen keys and leaves the hub record alone", async () => {
  const t = createTestHub();
  await t.hub.upsertSelf(sampleFingerprint({ federationRole: "hub" }));
  const { memberId } = await joinAndCheckIn(t);
  await t.hub.removeMember("edge-1");
  const removedVersion = t.members.version("edge-1");
  const sweeper = new MemberStatusSweeper({ hub: t.hub });
  t.clock.now += OFFLINE_AFTER_MS;
  const report = await sweeper.tick();
  assertEquals(report, { membersWritten: 0, seenKeysDeleted: 1 });
  assertEquals(await t.store.list(`federation/seen/${memberId}/`), []);
  assertEquals(t.members.version("edge-1"), removedVersion);
  assertEquals(t.members.version("hub"), 1);
  assertEquals(t.members.raw("hub")!.status, "online");
  await sweeper.stop();
});

Deno.test("MemberStatusSweeper: a tick joins the pass in flight, and stop waits for it", async () => {
  let release!: () => void;
  let passes = 0;
  const hub = {
    sweep: (): Promise<SweepReport> => {
      passes++;
      return new Promise((resolve) => {
        release = () => resolve({ membersWritten: 0, seenKeysDeleted: 0 });
      });
    },
  };
  const sweeper = new MemberStatusSweeper({ hub });
  const first = sweeper.tick();
  const second = sweeper.tick();
  assertEquals(passes, 1);
  let stopped = false;
  const stopping = sweeper.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assertEquals(stopped, false);
  release();
  await Promise.all([first, second, stopping]);
  assertEquals(stopped, true);
  assertEquals(await sweeper.tick(), undefined);
  assertEquals(passes, 1);
});

Deno.test("MemberStatusSweeper: a failed pass is logged, never thrown", async () => {
  const sweeper = new MemberStatusSweeper({
    hub: { sweep: () => Promise.reject(new Error("datastore down")) },
  });
  assertEquals(await sweeper.tick(), undefined);
  await sweeper.stop();
});
