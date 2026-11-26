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

import { assertEquals, assertRejects } from "@std/assert";
import { createInMemoryWorkerContext } from "../worker/worker_test_helpers.ts";
import { sampleFingerprintProps } from "../../serve/federation_test_helpers.ts";
import { InstanceId } from "../../serve/instance_id.ts";
import { MemberName } from "../../serve/member_name.ts";
import { ServeMember } from "../../serve/serve_member.ts";
import { Fingerprint } from "../../serve/fingerprint.ts";
import {
  SERVE_MEMBER_DATA_NAME,
  SERVE_MEMBER_MODEL_TYPE,
  serveMemberModel,
} from "./serve_member_model.ts";

const JOINED_AT = "2026-11-26T12:00:00.000Z";
const NOW = Date.parse(JOINED_AT);

async function joined(name = "edge-1") {
  const harness = createInMemoryWorkerContext(SERVE_MEMBER_MODEL_TYPE, name);
  const memberId = crypto.randomUUID();
  await serveMemberModel.methods.join.execute(
    {
      memberId,
      role: "member",
      fingerprint: sampleFingerprintProps(),
      joinedAt: JOINED_AT,
    },
    harness.context,
  );
  return { ...harness, memberId };
}

function stored(store: Map<string, Record<string, unknown>>): ServeMember {
  return ServeMember.fromJSON(store.get(SERVE_MEMBER_DATA_NAME));
}

Deno.test("serveMemberModel.join: writes the record under the definition's name", async () => {
  const { store, versions, memberId } = await joined();
  const member = stored(store);
  assertEquals(member.name, "edge-1");
  assertEquals(member.memberId, memberId);
  assertEquals(member.status, "online");
  assertEquals(member.joinedAt, JOINED_AT);
  assertEquals(versions.get(SERVE_MEMBER_DATA_NAME), 1);
  assertEquals("credentialHash" in store.get(SERVE_MEMBER_DATA_NAME)!, false);
});

Deno.test("serveMemberModel.join: refuses a live member and an invalid name", async () => {
  const { context } = await joined();
  await assertRejects(
    () =>
      serveMemberModel.methods.join.execute({
        memberId: crypto.randomUUID(),
        role: "member",
        fingerprint: sampleFingerprintProps(),
      }, context),
    Error,
    "already exists",
  );
  const bad = createInMemoryWorkerContext(SERVE_MEMBER_MODEL_TYPE, "a.b");
  await assertRejects(() =>
    serveMemberModel.methods.join.execute({
      memberId: crypto.randomUUID(),
      role: "member",
      fingerprint: sampleFingerprintProps(),
    }, bad.context)
  );
});

Deno.test("serveMemberModel.record: writes a new version only when the change rule asks", async () => {
  const { store, versions, context } = await joined();
  const id = InstanceId.create(crypto.randomUUID());
  const checked = stored(store).checkIn(
    id,
    Fingerprint.create(sampleFingerprintProps()),
    NOW,
  );
  if (!checked.ok) throw new Error(checked.refusal);
  await serveMemberModel.methods.record.execute(
    { record: checked.member.toJSON() },
    context,
  );
  assertEquals(versions.get(SERVE_MEMBER_DATA_NAME), 2);
  const result = await serveMemberModel.methods.record.execute(
    { record: checked.member.toJSON() },
    context,
  );
  assertEquals(result.dataHandles, []);
  assertEquals(versions.get(SERVE_MEMBER_DATA_NAME), 2);
});

Deno.test("serveMemberModel.record: refuses another member's record, a removal and a removed member", async () => {
  const { store, context } = await joined();
  const other = ServeMember.join({
    memberId: crypto.randomUUID(),
    name: MemberName.create(stored(store).name),
    role: "member",
    fingerprint: Fingerprint.create(sampleFingerprintProps()),
    now: NOW,
  });
  await assertRejects(
    () =>
      serveMemberModel.methods.record.execute(
        { record: other.toJSON() },
        context,
      ),
    Error,
    "is not serve member",
  );
  const removed = stored(store).remove(NOW).member;
  await assertRejects(
    () =>
      serveMemberModel.methods.record.execute(
        { record: removed.toJSON() },
        context,
      ),
    Error,
    "remove method",
  );
  await serveMemberModel.methods.remove.execute({}, context);
  await assertRejects(
    () =>
      serveMemberModel.methods.record.execute(
        { record: stored(store).toJSON() },
        context,
      ),
    Error,
    "removed",
  );
});

Deno.test("serveMemberModel.remove: terminal, and a second remove writes nothing", async () => {
  const { store, versions, context } = await joined();
  await serveMemberModel.methods.remove.execute(
    { removedAt: JOINED_AT },
    context,
  );
  assertEquals(stored(store).status, "removed");
  assertEquals(versions.get(SERVE_MEMBER_DATA_NAME), 2);
  const again = await serveMemberModel.methods.remove.execute({}, context);
  assertEquals(again.dataHandles, []);
  assertEquals(versions.get(SERVE_MEMBER_DATA_NAME), 2);
});

Deno.test("serveMemberModel.join: a removed member's name may join again", async () => {
  const { store, context } = await joined();
  await serveMemberModel.methods.remove.execute({}, context);
  const memberId = crypto.randomUUID();
  await serveMemberModel.methods.join.execute({
    memberId,
    role: "member",
    fingerprint: sampleFingerprintProps(),
  }, context);
  assertEquals(stored(store).memberId, memberId);
  assertEquals(stored(store).status, "online");
});
