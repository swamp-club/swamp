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

const ACTIONS: readonly Action[] = ActionSchema.options;
const NON_APPROVE_ACTIONS = ACTIONS.filter((a) => a !== "approve");

/** Conditions are the literals "true" and "false", evaluated as themselves. */
const literalEvaluator = (condition: string): boolean => condition === "true";

const OPS_GROUP: Group = {
  name: "ops",
  members: [{ kind: "user", id: "adam" }],
  createdBy: { kind: "user", id: "admin" },
  createdAt: "2026-01-01T00:00:00Z",
};

const PRINCIPAL: AccessPrincipal = {
  principal: { kind: "user", id: "adam" },
  collectives: [],
  groups: ["idp-ops"],
};

const RESOURCE: AccessResource = {
  kind: "workflow",
  name: "@acme/deploy",
  fields: { name: "@acme/deploy", tags: {}, collective: "" },
};

const arbGrant: fc.Arbitrary<Grant> = fc.record({
  subject: fc.constantFrom(
    { kind: "user" as const, name: "adam" },
    { kind: "user" as const, name: "eve" },
    { kind: "group" as const, name: "ops" },
    { kind: "idp-group" as const, name: "idp-ops" },
  ),
  effect: fc.constantFrom("allow" as const, "deny" as const),
  actions: fc.subarray([...ACTIONS], { minLength: 1 }),
  pattern: fc.constantFrom("*", "@acme/*", "@acme/deploy", "@other/*"),
  condition: fc.constantFrom(undefined, "true", "false"),
}).map(({ subject, effect, actions, pattern, condition }) => ({
  id: crypto.randomUUID(),
  subject,
  effect,
  actions,
  resource: { kind: "workflow" as const, pattern },
  state: "active" as const,
  source: "method" as const,
  createdBy: { kind: "user" as const, id: "admin" },
  createdAt: "2026-01-01T00:00:00Z",
  ...(condition ? { condition } : {}),
}));

const arbGrants = fc.array(arbGrant, { maxLength: 12 });

function servicesFor(grants: Grant[]): {
  implied: GrantBasedAccessDecisionService;
  explicit: GrantBasedAccessDecisionService;
} {
  const snapshot = new PolicySnapshot(grants, [OPS_GROUP], literalEvaluator);
  return {
    implied: new GrantBasedAccessDecisionService(snapshot),
    explicit: new GrantBasedAccessDecisionService(snapshot, {
      runImpliesApprove: false,
    }),
  };
}

Deno.test("GrantBasedAccessDecisionService: runImpliesApprove never changes decisions for other actions", () => {
  fc.assert(
    fc.property(
      arbGrants,
      fc.constantFrom(...NON_APPROVE_ACTIONS),
      (grants, action) => {
        const { implied, explicit } = servicesFor(grants);
        assertEquals(
          explicit.decide(PRINCIPAL, action, RESOURCE),
          implied.decide(PRINCIPAL, action, RESOURCE),
        );
        assertEquals(
          explicit.explain(PRINCIPAL, action, RESOURCE),
          implied.explain(PRINCIPAL, action, RESOURCE),
        );
        assertEquals(
          explicit.hasAnyGrantForKind(PRINCIPAL, action, "workflow"),
          implied.hasAnyGrantForKind(PRINCIPAL, action, "workflow"),
        );
      },
    ),
  );
});

Deno.test("GrantBasedAccessDecisionService: runImpliesApprove false only narrows approve", () => {
  fc.assert(
    fc.property(arbGrants, (grants) => {
      const { implied, explicit } = servicesFor(grants);
      const strict = explicit.decide(PRINCIPAL, "approve", RESOURCE);
      const lenient = implied.decide(PRINCIPAL, "approve", RESOURCE);
      if (strict?.effect === "allow") {
        // Anything allowed without the implication is allowed with it, and
        // it came from a grant that names approve itself.
        assertEquals(lenient?.effect, "allow");
        assertEquals(strict.impliedBy, undefined);
      }
      if (lenient?.effect === "deny") {
        // Every deny still applies, including a deny on run.
        assertEquals(strict, lenient);
      }
      if (
        explicit.hasAnyGrantForKind(PRINCIPAL, "approve", "workflow")
      ) {
        assert(implied.hasAnyGrantForKind(PRINCIPAL, "approve", "workflow"));
      }
    }),
  );
});

Deno.test("GrantBasedAccessDecisionService: explain for approve differs only by run-only allow grants", () => {
  fc.assert(
    fc.property(arbGrants, (grants) => {
      const { implied, explicit } = servicesFor(grants);
      const expected = implied
        .explain(PRINCIPAL, "approve", RESOURCE)
        .filter((d) => !(d.effect === "allow" && d.impliedBy === "run"));
      assertEquals(explicit.explain(PRINCIPAL, "approve", RESOURCE), expected);
    }),
  );
});
