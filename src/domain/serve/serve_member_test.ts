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

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { sampleFingerprint } from "./federation_test_helpers.ts";
import { InstanceId } from "./instance_id.ts";
import { MemberName } from "./member_name.ts";
import {
  CHECK_IN_INTERVAL_SECONDS,
  INSTANCE_TTL_MS,
  MAX_INSTANCES,
  OFFLINE_AFTER_MS,
  ServeMember,
  STALE_AFTER_MS,
} from "./serve_member.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");

function joined(role: "member" | "hub" = "member"): ServeMember {
  return ServeMember.join({
    memberId: crypto.randomUUID(),
    name: MemberName.create("edge-1"),
    role,
    fingerprint: sampleFingerprint(),
    now: NOW,
  });
}

function checkedIn(member: ServeMember, id: InstanceId, at = NOW) {
  const result = member.checkIn(id, sampleFingerprint(), at);
  if (!result.ok) throw new Error(result.refusal);
  return result;
}

Deno.test("ServeMember constants: the check-in interval and thresholds", () => {
  assertEquals(CHECK_IN_INTERVAL_SECONDS, 30);
  assertEquals(STALE_AFTER_MS, 90_000);
  assertEquals(OFFLINE_AFTER_MS, 600_000);
  assertEquals(INSTANCE_TTL_MS, 86_400_000);
  assertEquals(MAX_INSTANCES, 64);
});

Deno.test("ServeMember.join: online, no instances, refuses a non-UUID id", () => {
  const member = joined();
  assertEquals(member.status, "online");
  assertEquals(member.instances.length, 0);
  assertThrows(() =>
    ServeMember.join({
      memberId: "../x",
      name: MemberName.create("a"),
      role: "member",
      fingerprint: sampleFingerprint(),
      now: NOW,
    })
  );
});

Deno.test("ServeMember.checkIn: a new instance needs a write, a repeat does not", () => {
  const id = InstanceId.create(crypto.randomUUID());
  const first = checkedIn(joined(), id);
  assertEquals(first.changed, true);
  assertEquals(first.member.instanceIds(), [id.value]);
  const again = checkedIn(first.member, id, NOW + 30_000);
  assertEquals(again.changed, false);
  assertStrictEquals(again.member, first.member);
});

Deno.test("ServeMember.checkIn: runtime fields alone never need a write", () => {
  const id = InstanceId.create(crypto.randomUUID());
  const first = checkedIn(joined(), id);
  const runtime = first.member.checkIn(
    id,
    sampleFingerprint({ startedAt: "2026-11-26T11:00:00Z", ready: true }),
    NOW,
  );
  assertEquals(runtime.ok && runtime.changed, false);
});

Deno.test("ServeMember.checkIn: configuration drift and a pool change need a write", () => {
  const id = InstanceId.create(crypto.randomUUID());
  const first = checkedIn(joined(), id);
  const drift = first.member.checkIn(
    id,
    sampleFingerprint({ authMode: "oauth" }),
    NOW,
  );
  assertEquals(drift.ok && drift.changed, true);
  const pool = first.member.checkIn(
    id,
    sampleFingerprint({
      workers: { total: 1, byVersion: { v: 1 }, byLabelKey: {} },
    }),
    NOW,
  );
  assertEquals(pool.ok && pool.changed, true);
});

Deno.test("ServeMember.checkIn: the 65th instance is refused", () => {
  let member = joined();
  for (let i = 0; i < MAX_INSTANCES; i++) {
    member = checkedIn(member, InstanceId.create(crypto.randomUUID())).member;
  }
  assertEquals(
    member.checkIn(
      InstanceId.create(crypto.randomUUID()),
      sampleFingerprint(),
      NOW,
    ),
    { ok: false, refusal: "instance-limit" },
  );
  const known = InstanceId.create(member.instances[0].instanceId);
  assertEquals(member.checkIn(known, sampleFingerprint(), NOW).ok, true);
});

Deno.test("ServeMember.applySeen: online, stale, offline by the freshest instance", () => {
  const a = InstanceId.create(crypto.randomUUID());
  const b = InstanceId.create(crypto.randomUUID());
  const member = checkedIn(checkedIn(joined(), a).member, b).member;
  const seen = (ageA: number, ageB: number, now: number) =>
    new Map([[a.value, now - ageA], [b.value, now - ageB]]);
  const later = NOW + 60 * 60_000;
  assertEquals(
    member.applySeen(seen(OFFLINE_AFTER_MS, 1000, later), later).member.status,
    "online",
  );
  const stale = member.applySeen(
    seen(STALE_AFTER_MS, STALE_AFTER_MS, later),
    later,
  );
  assertEquals(stale.member.status, "stale");
  assertEquals(stale.changed, true);
  assertEquals(
    member.applySeen(seen(OFFLINE_AFTER_MS, OFFLINE_AFTER_MS, later), later)
      .member.status,
    "offline",
  );
});

Deno.test("ServeMember.applySeen: prunes instances unseen for a day", () => {
  const a = InstanceId.create(crypto.randomUUID());
  const b = InstanceId.create(crypto.randomUUID());
  const member = checkedIn(checkedIn(joined(), a).member, b).member;
  const later = NOW + 2 * INSTANCE_TTL_MS;
  const result = member.applySeen(
    new Map([[a.value, later - INSTANCE_TTL_MS], [b.value, later - 1000]]),
    later,
  );
  assertEquals(result.prunedInstanceIds, [a.value]);
  assertEquals(result.member.instanceIds(), [b.value]);
  assertEquals(result.changed, true);
});

Deno.test("ServeMember.applySeen: no change, no write", () => {
  const a = InstanceId.create(crypto.randomUUID());
  const member = checkedIn(joined(), a).member;
  const result = member.applySeen(new Map([[a.value, NOW]]), NOW + 1000);
  assertEquals(result.changed, false);
  assertStrictEquals(result.member, member);
});

Deno.test("ServeMember.applySeen: the hub's own record stays online", () => {
  const hub = joined("hub");
  const result = hub.applySeen(new Map(), NOW + 10 * OFFLINE_AFTER_MS);
  assertEquals(result.member.status, "online");
  assertEquals(result.changed, false);
});

Deno.test("ServeMember.remove: terminal", () => {
  const id = InstanceId.create(crypto.randomUUID());
  const removed = joined().remove(NOW);
  assertEquals(removed.changed, true);
  assertEquals(removed.member.status, "removed");
  assertEquals(removed.member.removedAt, new Date(NOW).toISOString());
  assertEquals(removed.member.remove(NOW + 1).changed, false);
  assertEquals(
    removed.member.checkIn(id, sampleFingerprint(), NOW),
    { ok: false, refusal: "removed" },
  );
  assertEquals(
    removed.member.applySeen(new Map(), NOW + OFFLINE_AFTER_MS).changed,
    false,
  );
});

Deno.test("ServeMember.withFingerprint: writes only on a material change", () => {
  const hub = joined("hub");
  assertEquals(
    hub.withFingerprint(sampleFingerprint({ ready: true })).changed,
    false,
  );
  assertEquals(
    hub.withFingerprint(sampleFingerprint({ tls: false })).changed,
    true,
  );
});

Deno.test("ServeMember.fromJSON: round-trips and holds no credential or lastSeen", () => {
  const member = checkedIn(joined(), InstanceId.create(crypto.randomUUID()))
    .member;
  const json = member.toJSON();
  assertEquals(ServeMember.fromJSON(json).toJSON(), json);
  assertEquals(Object.keys(json).sort(), [
    "fingerprint",
    "instances",
    "joinedAt",
    "memberId",
    "name",
    "role",
    "status",
  ]);
  assertEquals(Object.keys(json.instances[0]).sort(), [
    "firstSeen",
    "instanceId",
    "swampVersion",
  ]);
  assertThrows(() => ServeMember.fromJSON({ ...json, credentialHash: "x" }));
  assertThrows(() => ServeMember.fromJSON({ ...json, name: "a.b" }));
});

Deno.test("ServeMember.needsNewVersionFrom: a first write always does", () => {
  assertEquals(joined().needsNewVersionFrom(null), true);
});
