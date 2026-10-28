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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import type { Grant } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import type {
  AccessPrincipal,
  AccessResource,
} from "./access_decision_service.ts";
import { type Action, ActionSchema } from "./action.ts";
import { GrantBasedAccessDecisionService } from "./grant_based_access_decision_service.ts";
import { PolicySnapshot } from "./policy_snapshot.ts";
import type { Subject } from "./subject.ts";

/** Conditions are the literals "true" and "false", evaluated as themselves. */
const literalEvaluator = (condition: string): boolean => condition === "true";

const GROUPS: readonly Group[] = [
  {
    name: "ops",
    members: [{ kind: "user", id: "adam" }],
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  },
  {
    name: "devs",
    members: [{ kind: "user", id: "bob" }],
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  },
];

const ADAM: AccessPrincipal = {
  principal: { kind: "user", id: "adam" },
  collectives: [],
  groups: ["idp-ops"],
};

/** Subjects that are adam's, and subjects that are not. */
const ADAM_SUBJECTS: readonly Subject[] = [
  { kind: "user", name: "adam" },
  { kind: "group", name: "ops" },
  { kind: "idp-group", name: "idp-ops" },
];
const OTHER_SUBJECTS: readonly Subject[] = [
  { kind: "user", name: "bob" },
  { kind: "group", name: "devs" },
  { kind: "idp-group", name: "idp-devs" },
];

const KINDS = ["data", "model", "workflow", "access"] as const;
const NAMES = ["web", "api", "db"] as const;

/** Every resource the decisions are compared over. */
const RESOURCES: readonly AccessResource[] = KINDS.flatMap((kind) =>
  NAMES.map((name) => ({ kind, name, fields: { name } }))
);

const grantArb = (subjects: readonly Subject[]): fc.Arbitrary<Grant> =>
  fc.record({
    id: fc.uuid(),
    subject: fc.constantFrom(...subjects),
    effect: fc.constantFrom("allow" as const, "deny" as const),
    actions: fc.uniqueArray(
      fc.constantFrom(...(ActionSchema.options as readonly Action[])),
      { minLength: 1, maxLength: 3 },
    ),
    kind: fc.constantFrom(...KINDS),
    pattern: fc.constantFrom("*", ...NAMES),
    condition: fc.option(fc.constantFrom("true", "false"), { nil: undefined }),
  }).map(({ kind, pattern, condition, ...rest }) => ({
    ...rest,
    resource: { kind, pattern },
    ...(condition !== undefined ? { condition } : {}),
    state: "active" as const,
    source: "method" as const,
    createdBy: { kind: "user" as const, id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  }));

/** Adam's read and admin decisions over every resource, as serve's filter makes them. */
function readDecisions(service: GrantBasedAccessDecisionService): string[] {
  return (["read", "admin"] as const).flatMap((action) =>
    RESOURCES.map((resource) => {
      const decision = service.decide(ADAM, action, resource);
      return decision === null ? "none" : decision.effect;
    })
  );
}

function serviceOf(grants: readonly Grant[]): GrantBasedAccessDecisionService {
  return new GrantBasedAccessDecisionService(
    new PolicySnapshot(grants, GROUPS, literalEvaluator),
  );
}

Deno.test("readAccessFingerprint property: an unchanged fingerprint means unchanged read decisions", () => {
  fc.assert(
    fc.property(
      fc.array(grantArb([...ADAM_SUBJECTS, ...OTHER_SUBJECTS]), {
        maxLength: 8,
      }),
      grantArb([...ADAM_SUBJECTS, ...OTHER_SUBJECTS]),
      (grants, added) => {
        const before = serviceOf(grants);
        const after = serviceOf([...grants, added]);
        if (
          before.readAccessFingerprint(ADAM) ===
            after.readAccessFingerprint(ADAM)
        ) {
          assertEquals(readDecisions(after), readDecisions(before));
        }
      },
    ),
    { numRuns: 500 },
  );
});

Deno.test("readAccessFingerprint property: other subjects' grants never change it", () => {
  fc.assert(
    fc.property(
      fc.array(grantArb(ADAM_SUBJECTS), { maxLength: 6 }),
      fc.array(grantArb(OTHER_SUBJECTS), { minLength: 1, maxLength: 6 }),
      (own, others) => {
        assertEquals(
          serviceOf([...own, ...others]).readAccessFingerprint(ADAM),
          serviceOf(own).readAccessFingerprint(ADAM),
        );
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("readAccessFingerprint property: one of adam's read or admin grants always changes it", () => {
  fc.assert(
    fc.property(
      fc.array(grantArb(ADAM_SUBJECTS), { maxLength: 6 }),
      grantArb(ADAM_SUBJECTS).filter((grant) =>
        grant.actions.includes("read") || grant.actions.includes("admin")
      ),
      (grants, added) => {
        assert(
          serviceOf([...grants, added]).readAccessFingerprint(ADAM) !==
            serviceOf(grants).readAccessFingerprint(ADAM),
        );
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("readAccessFingerprint property: grant order never changes it", () => {
  fc.assert(
    fc.property(
      fc.array(grantArb([...ADAM_SUBJECTS, ...OTHER_SUBJECTS]), {
        maxLength: 8,
      }),
      (grants) => {
        assertEquals(
          serviceOf([...grants].reverse()).readAccessFingerprint(ADAM),
          serviceOf(grants).readAccessFingerprint(ADAM),
        );
      },
    ),
    { numRuns: 200 },
  );
});
