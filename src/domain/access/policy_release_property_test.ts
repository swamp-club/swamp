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

import fc from "fast-check";
import { assertEquals } from "@std/assert";
import type { Grant } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import { narrowedPolicy, PolicyRelease } from "./policy_release.ts";
import { PolicySnapshot } from "./policy_snapshot.ts";
import { GrantBasedAccessDecisionService } from "./grant_based_access_decision_service.ts";

const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/);
const instant = fc.constantFrom(
  "2026-01-01T00:00:00Z",
  "2026-11-19T12:30:00.000Z",
);

const grant: fc.Arbitrary<Grant> = fc.record({
  id: fc.uuid(),
  subject: fc.record({ kind: fc.constant("user" as const), name }),
  effect: fc.constantFrom("allow" as const, "deny" as const),
  actions: fc.constantFrom(["read"], ["read", "run"], ["write"]),
  resource: fc.record({
    kind: fc.constant("workflow" as const),
    pattern: name,
  }),
  state: fc.constant("active" as const),
  source: fc.constant("method" as const),
  createdBy: fc.record({ kind: fc.constant("user" as const), id: name }),
  createdAt: instant,
}) as fc.Arbitrary<Grant>;

const group: fc.Arbitrary<Group> = fc.record({
  name,
  members: fc.array(
    fc.record({ kind: fc.constant("user" as const), id: name }),
    { maxLength: 4 },
  ),
  createdBy: fc.record({ kind: fc.constant("user" as const), id: name }),
  createdAt: instant,
}) as fc.Arbitrary<Group>;

const release = fc.record({
  grants: fc.array(grant, { maxLength: 6 }),
  groups: fc.array(group, { maxLength: 4 }),
  known: fc.array(grant, { maxLength: 4 }),
  decisions: fc.record({
    runImpliesApprove: fc.boolean(),
    runImpliesSignal: fc.boolean(),
    writeImpliesTag: fc.boolean(),
  }),
}).map(({ grants, groups, known, decisions }) =>
  PolicyRelease.of({
    grants,
    groups,
    knownGrants: new Map(known.map((g) => [`swamp/grant/${g.id}`, g])),
    knownGroups: new Map(groups.map((g, i) => [`swamp/group/m${i}`, g])),
    decisions,
  })
);

Deno.test("PolicyRelease: a JSON round trip keeps the attrs and the digest", () => {
  fc.assert(
    fc.property(release, (original) => {
      const read = PolicyRelease.parse(
        JSON.parse(JSON.stringify(original.toAttrs())),
      );
      assertEquals(read.toAttrs(), original.toAttrs());
      assertEquals(read.digest(), original.digest());
    }),
  );
});

Deno.test("PolicyRelease.digest: does not depend on the order of grants or groups", () => {
  fc.assert(
    fc.property(release, (original) => {
      const reversed = PolicyRelease.of({
        grants: [...original.grants].reverse(),
        groups: [...original.groups].reverse(),
        knownGrants: new Map([...original.knownGrants].reverse()),
        knownGroups: new Map([...original.knownGroups].reverse()),
        decisions: original.decisions,
      });
      assertEquals(reversed.digest(), original.digest());
    }),
  );
});

const USERS = ["ann", "bob"];
const GROUPS = ["ops", "dev"];

const smallGrant: fc.Arbitrary<Grant> = fc.record({
  id: fc.constantFrom("g1", "g2", "g3", "g4"),
  subject: fc.oneof(
    fc.record({
      kind: fc.constant("user" as const),
      name: fc.constantFrom(...USERS),
    }),
    fc.record({
      kind: fc.constant("group" as const),
      name: fc.constantFrom(...GROUPS),
    }),
  ),
  effect: fc.constantFrom("allow" as const, "deny" as const),
  actions: fc.constant(["read"]),
  resource: fc.record({
    kind: fc.constant("workflow" as const),
    pattern: fc.constantFrom("*", "x"),
  }),
  state: fc.constant("active" as const),
  source: fc.constant("method" as const),
  createdBy: fc.constant({ kind: "user" as const, id: "admin" }),
  createdAt: fc.constant("2026-01-01T00:00:00Z"),
}) as fc.Arbitrary<Grant>;

const smallGroups: fc.Arbitrary<Group[]> = fc.subarray(GROUPS).chain((names) =>
  fc.tuple(
    ...names.map((name) =>
      fc.subarray(USERS).map((members) => ({
        name,
        members: members.map((id) => ({ kind: "user" as const, id })),
        createdBy: { kind: "user" as const, id: "admin" },
        createdAt: "2026-01-01T00:00:00Z",
      }))
    ),
  ).map((groups) => [...groups])
);

const smallPolicy = fc.record({
  grants: fc.array(smallGrant, { maxLength: 5 }),
  groups: smallGroups,
});

function allowed(
  policy: { grants: readonly Grant[]; groups: readonly Group[] },
  user: string,
  name: string,
): boolean {
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot(policy.grants, policy.groups),
  );
  return service.decide(
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

// the latest policy is the release changed a little, as a grant commit leaves it
const releaseAndLatest = smallPolicy.chain((release) =>
  fc.record({
    kept: fc.subarray(release.grants),
    added: fc.array(smallGrant, { maxLength: 2 }),
    groups: fc.tuple(
      ...release.groups.map((group) =>
        fc.subarray(USERS).map((ids) => ({
          ...group,
          members: ids.map((id) => ({ kind: "user" as const, id })),
        }))
      ),
    ),
  }).map(({ kept, added, groups }) => ({
    release,
    latest: { grants: [...kept, ...added], groups: [...groups] },
  }))
);

Deno.test("narrowedPolicy: allows nothing the release or the latest policy refuses", () => {
  fc.assert(
    fc.property(releaseAndLatest, ({ release, latest }) => {
      const narrowed = narrowedPolicy(release, latest);
      for (const user of USERS) {
        for (const name of ["x", "y"]) {
          if (allowed(narrowed, user, name)) {
            assertEquals(allowed(release, user, name), true);
            assertEquals(allowed(latest, user, name), true);
          }
        }
      }
    }),
    { numRuns: 3000 },
  );
});

Deno.test("narrowedPolicy: with nothing changed, it is the release's policy", () => {
  fc.assert(
    fc.property(smallPolicy, (policy) => {
      for (const user of USERS) {
        for (const name of ["x", "y"]) {
          assertEquals(
            allowed(narrowedPolicy(policy, policy), user, name),
            allowed(policy, user, name),
          );
        }
      }
    }),
  );
});
