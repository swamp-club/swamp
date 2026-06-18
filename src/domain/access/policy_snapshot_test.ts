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
import type { Grant } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import type { PrincipalContext } from "./principal_context.ts";
import { type ConditionEvaluator, PolicySnapshot } from "./policy_snapshot.ts";
import type { ResourceKind } from "./resource_selector.ts";

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeGroup(name: string, memberIds: string[]): Group {
  return {
    name,
    members: memberIds.map((id) => ({ kind: "user" as const, id })),
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

Deno.test("PolicySnapshot.grantsForSubjects: returns grants matching any of the given subjects", () => {
  const g1 = makeGrant({ subject: { kind: "user", name: "adam" } });
  const g2 = makeGrant({ subject: { kind: "group", name: "devs" } });
  const g3 = makeGrant({ subject: { kind: "user", name: "eve" } });
  const snapshot = new PolicySnapshot([g1, g2, g3], []);

  const result = snapshot.grantsForSubjects(["user:adam", "group:devs"]);
  assertEquals(result.length, 2);
  assertEquals(result[0].id, g1.id);
  assertEquals(result[1].id, g2.id);
});

Deno.test("PolicySnapshot.grantsForSubjects: returns empty for unmatched subjects", () => {
  const g1 = makeGrant({ subject: { kind: "user", name: "adam" } });
  const snapshot = new PolicySnapshot([g1], []);

  const result = snapshot.grantsForSubjects(["user:eve"]);
  assertEquals(result.length, 0);
});

Deno.test("PolicySnapshot.groupsForPrincipal: returns local group names for a member", () => {
  const groups = [
    makeGroup("devs", ["adam", "eve"]),
    makeGroup("admins", ["adam"]),
  ];
  const snapshot = new PolicySnapshot([], groups);

  const result = snapshot.groupsForPrincipal("user:adam");
  assertEquals(result.length, 2);
  assertEquals([...result].sort(), ["admins", "devs"]);
});

Deno.test("PolicySnapshot.groupsForPrincipal: returns empty for non-member", () => {
  const groups = [makeGroup("devs", ["adam"])];
  const snapshot = new PolicySnapshot([], groups);

  const result = snapshot.groupsForPrincipal("user:eve");
  assertEquals(result.length, 0);
});

function stubEvaluator(
  expected: { condition: string; result: boolean }[],
): ConditionEvaluator {
  return (
    condition: string,
    _resourceKind: ResourceKind,
    _resourceFields: Record<string, unknown>,
    _principalContext: PrincipalContext,
  ): boolean => {
    const match = expected.find((e) => e.condition === condition);
    return match?.result ?? false;
  };
}

Deno.test("PolicySnapshot.evaluateCondition: delegates to provided evaluator", () => {
  const evaluator = stubEvaluator([
    { condition: 'name == "deploy"', result: true },
  ]);
  const snapshot = new PolicySnapshot([], [], evaluator);

  const result = snapshot.evaluateCondition(
    'name == "deploy"',
    "workflow",
    { name: "deploy", tags: {}, collective: "" },
    { sub: "adam", groups: [], collectives: [] },
  );
  assertEquals(result, true);
});

Deno.test("PolicySnapshot.evaluateCondition: returns false for non-matching condition", () => {
  const evaluator = stubEvaluator([
    { condition: 'name == "build"', result: false },
  ]);
  const snapshot = new PolicySnapshot([], [], evaluator);

  const result = snapshot.evaluateCondition(
    'name == "build"',
    "workflow",
    { name: "deploy", tags: {}, collective: "" },
    { sub: "adam", groups: [], collectives: [] },
  );
  assertEquals(result, false);
});

Deno.test("PolicySnapshot.evaluateCondition: returns false when no evaluator provided", () => {
  const snapshot = new PolicySnapshot([], []);

  const result = snapshot.evaluateCondition(
    'principal.sub == "adam"',
    "workflow",
    { name: "deploy", tags: {}, collective: "" },
    { sub: "adam", groups: ["devs"], collectives: ["org1"] },
  );
  assertEquals(result, false);
});

Deno.test("PolicySnapshot.evaluateCondition: returns false when evaluator throws", () => {
  const throwingEvaluator: ConditionEvaluator = () => {
    throw new Error("Unknown variable: tags");
  };
  const snapshot = new PolicySnapshot([], [], throwingEvaluator);

  const result = snapshot.evaluateCondition(
    'tags.env == "staging"',
    "workflow",
    {},
    { sub: "adam", groups: [], collectives: [] },
  );
  assertEquals(result, false);
});

Deno.test("PolicySnapshot.empty: creates snapshot with no grants or groups", () => {
  const snapshot = PolicySnapshot.empty();
  assertEquals(snapshot.grantsForSubjects(["user:adam"]).length, 0);
  assertEquals(snapshot.groupsForPrincipal("user:adam").length, 0);
});
