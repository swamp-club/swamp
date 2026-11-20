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

import { assertEquals, assertThrows } from "@std/assert";
import type { Grant } from "../models/access/grant_model.ts";
import { narrowedPolicy, PolicyRelease } from "./policy_release.ts";
import type { Group } from "../models/access/group_model.ts";
import { PolicySnapshot } from "./policy_snapshot.ts";
import { GrantBasedAccessDecisionService } from "./grant_based_access_decision_service.ts";

const GRANT: Grant = {
  id: "g1",
  subject: { kind: "user", name: "adam" },
  effect: "allow",
  actions: ["read"],
  resource: { kind: "workflow", pattern: "*" },
  state: "active",
  source: "method",
  createdBy: { kind: "user", id: "admin" },
  createdAt: "2026-01-01T00:00:00Z",
};

const DECISIONS = {
  runImpliesApprove: true,
  runImpliesSignal: false,
  writeImpliesTag: true,
};

function release(): PolicyRelease {
  return PolicyRelease.of({
    grants: [GRANT],
    groups: [{
      name: "devs",
      members: [{ kind: "user", id: "adam" }],
      createdBy: { kind: "user", id: "admin" },
      createdAt: "2026-01-01T00:00:00Z",
    }],
    knownGrants: new Map([["swamp/grant/g1", GRANT]]),
    knownGroups: new Map(),
    decisions: DECISIONS,
  });
}

Deno.test("PolicyRelease.parse: reads back what toAttrs wrote", () => {
  const original = release();
  const read = PolicyRelease.parse(
    JSON.parse(JSON.stringify(original.toAttrs())),
  );
  assertEquals(read.toAttrs(), original.toAttrs());
  assertEquals(read.digest(), original.digest());
});

Deno.test("PolicyRelease.parse: refuses a record that is not a grant or group, and anything malformed", () => {
  const attrs = release().toAttrs();
  for (
    const bad of [
      { ...attrs, knownGrants: [{ record: "swamp/worker/w1", grant: GRANT }] },
      { ...attrs, knownGrants: [{ record: "swamp/grant/a/b", grant: GRANT }] },
      { ...attrs, v: 2 },
      { ...attrs, grants: [{ ...GRANT, actions: [] }] },
      { ...attrs, decisions: { ...DECISIONS, extra: true } },
      { ...attrs, extra: 1 },
      null,
    ]
  ) {
    assertThrows(() => PolicyRelease.parse(bad));
  }
});

Deno.test("PolicyRelease.digest: the same policy in another order has the same digest; a change does not", () => {
  const second = { ...GRANT, id: "g2" };
  const make = (grants: Grant[], decisions = DECISIONS) =>
    PolicyRelease.of({
      grants,
      groups: [],
      knownGrants: new Map(),
      knownGroups: new Map(),
      decisions,
    });
  assertEquals(
    make([GRANT, second]).digest(),
    make([second, GRANT]).digest(),
  );
  assertEquals(make([GRANT]).digest() === make([second]).digest(), false);
  assertEquals(
    make([GRANT]).digest() ===
      make([GRANT], { ...DECISIONS, writeImpliesTag: false }).digest(),
    false,
  );
});

function ops(...members: string[]): Group {
  return {
    name: "ops",
    members: members.map((id) => ({ kind: "user" as const, id })),
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function onOps(id: string, effect: "allow" | "deny", pattern: string): Grant {
  return {
    ...GRANT,
    id,
    subject: { kind: "group", name: "ops" },
    effect,
    resource: { kind: "workflow", pattern },
  };
}

function reads(
  policy: { grants: readonly Grant[]; groups: readonly Group[] },
  user: string,
  name: string,
): boolean {
  return new GrantBasedAccessDecisionService(
    new PolicySnapshot(policy.grants, policy.groups),
  ).decide(
    {
      principal: { kind: "user", id: user },
      collectives: [],
      groups: [],
      client: undefined,
      delegation: undefined,
    },
    "read",
    { kind: "workflow", name, fields: { name, tags: {}, collective: "" } },
  )?.effect === "allow";
}

Deno.test("narrowedPolicy: a member removed from a group that allows and denies loses its allow at once", () => {
  const grants = [onOps("a", "allow", "*"), onOps("d", "deny", "x")];
  const narrowed = narrowedPolicy(
    { grants, groups: [ops("ann", "bob")] },
    { grants, groups: [ops("bob")] },
  );
  assertEquals(reads(narrowed, "ann", "y"), false);
  assertEquals(reads(narrowed, "bob", "y"), true);
});

Deno.test("narrowedPolicy: a member removed from a group that denies stays denied until the release", () => {
  const grants = [onOps("d", "deny", "x"), onOps("a", "allow", "*"), {
    ...GRANT,
    id: "u",
    subject: { kind: "user" as const, name: "ann" },
    resource: { kind: "workflow" as const, pattern: "*" },
  }];
  const narrowed = narrowedPolicy(
    { grants, groups: [ops("ann", "bob")] },
    { grants, groups: [ops("bob")] },
  );
  // the release still denies ann on x through ops; the latest would allow it
  assertEquals(reads(narrowed, "ann", "x"), false);
  assertEquals(reads(narrowed, "ann", "y"), true);
});
