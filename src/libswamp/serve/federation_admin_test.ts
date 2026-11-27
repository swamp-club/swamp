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
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import { sampleFingerprint } from "../../domain/serve/federation_test_helpers.ts";
import type { JoinTokenView } from "../../domain/serve/join_token.ts";
import { MemberName } from "../../domain/serve/member_name.ts";
import { ServeMember } from "../../domain/serve/serve_member.ts";
import type { FederationAdmin } from "./federation_admin.ts";
import { memberGet } from "./member_get.ts";
import { memberList } from "./member_list.ts";
import { memberRemove } from "./member_remove.ts";
import { memberTokenCreate } from "./member_token_create.ts";
import { memberTokenList } from "./member_token_list.ts";
import { memberTokenRevoke } from "./member_token_revoke.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

class HubRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const TOKEN: JoinTokenView = {
  memberName: "edge-1",
  state: "unused",
  createdAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
};

const MEMBER = ServeMember.join({
  memberId: crypto.randomUUID(),
  name: MemberName.create("edge-1"),
  role: "member",
  fingerprint: sampleFingerprint(),
  now: NOW,
});

const INSTANCE = "00000000-0000-4000-8000-000000000001";
const RUNTIME = {
  team: { role: "single" as const, nodes: 1 },
  startedAt: new Date(NOW - 1000).toISOString(),
  ready: true,
};

function fakeAdmin(calls: string[] = []): FederationAdmin {
  return {
    createToken: (name, durationMs) => {
      calls.push(`create ${name} ${durationMs}`);
      return Promise.resolve({ token: TOKEN, plaintext: "edge-1.secret" });
    },
    listTokens: () => Promise.resolve([TOKEN]),
    revokeToken: (name) =>
      name === "edge-1"
        ? Promise.resolve({ ...TOKEN, state: "revoked" })
        : Promise.reject(
          new HubRefusal("not_found", `No join token for '${name}'`),
        ),
    listMembers: () => Promise.resolve([MEMBER]),
    getMember: (name) => Promise.resolve(name === "edge-1" ? MEMBER : null),
    removeMember: () => Promise.resolve(MEMBER.remove(NOW).member),
    now: () => NOW + 5000,
    sightings: (memberId) => {
      calls.push(`sightings ${memberId ?? "*"}`);
      return Promise.resolve(
        new Map([[MEMBER.memberId, [{
          instanceId: INSTANCE,
          at: NOW,
          runtime: RUNTIME,
        }]]]),
      );
    },
  };
}

const ctx = createLibSwampContext();

function kinds(events: { kind: string }[]): string[] {
  return events.map((event) => event.kind);
}

Deno.test("memberTokenCreate: mints with the default hour and returns the plaintext once", async () => {
  const calls: string[] = [];
  const events = await collect(
    memberTokenCreate(ctx, { admin: fakeAdmin(calls) }, { name: "edge-1" }),
  );
  assertEquals(kinds(events), ["resolving", "completed"]);
  assertEquals(calls, ["create edge-1 3600000"]);
  const done = events[1];
  if (done.kind !== "completed") throw new Error("not completed");
  assertEquals(done.data, { token: TOKEN, joinToken: "edge-1.secret" });
});

Deno.test("memberTokenCreate: refuses a duration over 30 days without asking the hub", async () => {
  const calls: string[] = [];
  for (const durationMs of [31 * DAY_MS, 0, 1.5]) {
    const events = await collect(
      memberTokenCreate(ctx, { admin: fakeAdmin(calls) }, {
        name: "edge-1",
        durationMs,
      }),
    );
    const last = events[events.length - 1];
    if (last.kind !== "error") throw new Error("not refused");
    assertEquals(last.error.code, "invalid_duration");
  }
  assertEquals(calls, []);
});

Deno.test("memberTokenList and memberTokenRevoke: answer from the hub and keep its refusal code", async () => {
  const listed = await collect(memberTokenList(ctx, { admin: fakeAdmin() }));
  assertEquals(listed[1], { kind: "completed", data: { tokens: [TOKEN] } });
  const revoked = await collect(
    memberTokenRevoke(ctx, { admin: fakeAdmin() }, { name: "edge-1" }),
  );
  assertEquals(revoked[1], {
    kind: "completed",
    data: { token: { ...TOKEN, state: "revoked" } },
  });
  const missing = await collect(
    memberTokenRevoke(ctx, { admin: fakeAdmin() }, { name: "edge-9" }),
  );
  const last = missing[missing.length - 1];
  if (last.kind !== "error") throw new Error("not refused");
  assertEquals(last.error.code, "not_found");
});

const LIVE = {
  lastSeenAt: new Date(NOW).toISOString(),
  instances: [{
    instanceId: INSTANCE,
    lastSeenAt: new Date(NOW).toISOString(),
    runtime: RUNTIME,
  }],
};

Deno.test("memberList and memberGet: each record carries its live view and the hub's time; memberRemove does not", async () => {
  const calls: string[] = [];
  const listed = await collect(memberList(ctx, { admin: fakeAdmin(calls) }));
  assertEquals(listed[1], {
    kind: "completed",
    data: {
      members: [{ ...MEMBER.toJSON(), live: LIVE }],
      now: new Date(NOW + 5000).toISOString(),
    },
  });
  const got = await collect(
    memberGet(ctx, { admin: fakeAdmin(calls) }, { name: "edge-1" }),
  );
  assertEquals(got[1], {
    kind: "completed",
    data: {
      member: { ...MEMBER.toJSON(), live: LIVE },
      now: new Date(NOW + 5000).toISOString(),
    },
  });
  assertEquals(calls, ["sightings *", `sightings ${MEMBER.memberId}`]);
  const removed = await collect(
    memberRemove(ctx, { admin: fakeAdmin() }, { name: "edge-1" }),
  );
  const done = removed[1];
  if (done.kind !== "completed") throw new Error("not completed");
  assertEquals(done.data.member.status, "removed");
  assertEquals("live" in done.data.member, false);
});

Deno.test("memberList: a member that never checked in has an empty live view", async () => {
  const admin: FederationAdmin = {
    ...fakeAdmin(),
    sightings: () => Promise.resolve(new Map()),
  };
  const listed = await collect(memberList(ctx, { admin }));
  const done = listed[1];
  if (done.kind !== "completed") throw new Error("not completed");
  assertEquals(done.data.members[0].live, { lastSeenAt: null, instances: [] });
});

Deno.test("memberGet: a missing member is not_found; an unexpected failure keeps a generic code", async () => {
  const missing = await collect(
    memberGet(ctx, { admin: fakeAdmin() }, { name: "nobody" }),
  );
  const last = missing[missing.length - 1];
  if (last.kind !== "error") throw new Error("not refused");
  assertEquals(last.error.code, "not_found");

  const broken: FederationAdmin = {
    ...fakeAdmin(),
    listMembers: () => Promise.reject(new Error("disk on fire")),
  };
  const failed = await collect(memberList(ctx, { admin: broken }));
  const error = failed[failed.length - 1];
  if (error.kind !== "error") throw new Error("not refused");
  assertEquals(error.error, {
    code: "member_list_failed",
    message: "disk on fire",
  });
});
