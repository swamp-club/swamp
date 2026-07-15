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
import {
  evaluateGrantCondition,
  MAX_AGGREGATE_CONDITIONS,
} from "../../infrastructure/cel/grant_condition_environment.ts";
import type { Grant } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import type {
  AccessPrincipal,
  AccessResource,
} from "./access_decision_service.ts";
import { GrantBasedAccessDecisionService } from "./grant_based_access_decision_service.ts";
import type { ConditionEvaluator } from "./policy_snapshot.ts";
import { PolicySnapshot } from "./policy_snapshot.ts";

const celEvaluator: ConditionEvaluator = evaluateGrantCondition;

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

function makePrincipal(
  id: string,
  collectives: string[] = [],
  groups: string[] = [],
): AccessPrincipal {
  return { principal: { kind: "user", id }, collectives, groups };
}

function makeResource(
  overrides: Partial<AccessResource> = {},
): AccessResource {
  return {
    kind: "workflow",
    name: "@acme/deploy",
    fields: { name: "@acme/deploy", tags: {}, collective: "" },
    ...overrides,
  };
}

Deno.test("decide: returns null (default deny) when no grants exist", () => {
  const service = new GrantBasedAccessDecisionService(PolicySnapshot.empty());
  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result, null);
});

Deno.test("decide: allows when a matching allow grant exists", () => {
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result?.effect, "allow");
  assertEquals(result?.grantId, grant.id);
});

Deno.test("decide: deny wins over allow", () => {
  const allow = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const deny = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "deny",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const snapshot = new PolicySnapshot([allow, deny], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result?.effect, "deny");
  assertEquals(result?.grantId, deny.id);
});

Deno.test("decide: returns null when action does not match", () => {
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["write"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result, null);
});

Deno.test("decide: returns null when resource kind does not match", () => {
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "model", pattern: "*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result, null);
});

Deno.test("decide: matches via resource pattern", () => {
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "@acme/*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: resolves local group membership from snapshot", () => {
  const grant = makeGrant({
    subject: { kind: "group", name: "release-managers" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const group = makeGroup("release-managers", ["adam"]);
  const snapshot = new PolicySnapshot([grant], [group], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", makeResource());
  assertEquals(result?.effect, "allow");
  assertEquals(result?.subject, { kind: "group", name: "release-managers" });
});

Deno.test("decide: resolves IdP-asserted group from collectives", () => {
  const grant = makeGrant({
    subject: { kind: "idp-group", name: "platform-eng" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(
    makePrincipal("adam", [], ["platform-eng"]),
    "read",
    makeResource(),
  );
  assertEquals(result?.effect, "allow");
  assertEquals(result?.subject, { kind: "idp-group", name: "platform-eng" });
});

Deno.test("decide: does not match IdP group when not in collectives", () => {
  const grant = makeGrant({
    subject: { kind: "idp-group", name: "platform-eng" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result, null);
});

Deno.test("decide: evaluates CEL condition on grant", () => {
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    condition: 'name == "@acme/deploy"',
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result?.effect, "allow");
  assertEquals(result?.condition, 'name == "@acme/deploy"');
});

Deno.test("decide: skips grant when CEL condition is false", () => {
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    condition: 'name == "other"',
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result, null);
});

Deno.test("decide: deny with condition only denies when condition is true", () => {
  const deny = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "deny",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    condition: 'name == "other"',
  });
  const allow = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const snapshot = new PolicySnapshot([deny, allow], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result?.effect, "allow");
});

Deno.test("explain: returns all matching grants without short-circuit", () => {
  const allow1 = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const allow2 = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "@acme/*" },
  });
  const deny = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "deny",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "@acme/deploy" },
  });
  const snapshot = new PolicySnapshot([allow1, allow2, deny], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.explain(
    makePrincipal("adam"),
    "read",
    makeResource(),
  );
  assertEquals(result.length, 3);
  const effects = result.map((d) => d.effect);
  assertEquals(effects.includes("deny"), true);
  assertEquals(effects.filter((e) => e === "allow").length, 2);
});

Deno.test("explain: returns empty when no grants match", () => {
  const service = new GrantBasedAccessDecisionService(PolicySnapshot.empty());
  const result = service.explain(
    makePrincipal("adam"),
    "read",
    makeResource(),
  );
  assertEquals(result.length, 0);
});

Deno.test("explain: includes grants matched via group and IdP-group subjects", () => {
  const userGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const groupGrant = makeGrant({
    subject: { kind: "group", name: "devs" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const idpGrant = makeGrant({
    subject: { kind: "idp-group", name: "org1" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const group = makeGroup("devs", ["adam"]);
  const snapshot = new PolicySnapshot(
    [userGrant, groupGrant, idpGrant],
    [group],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.explain(
    makePrincipal("adam", [], ["org1"]),
    "read",
    makeResource(),
  );
  assertEquals(result.length, 3);
});

Deno.test("decide: snapshot can be swapped atomically", () => {
  const grant1 = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot([grant1], [], celEvaluator),
  );

  assertEquals(
    service.decide(makePrincipal("adam"), "read", makeResource())?.effect,
    "allow",
  );

  service.snapshot = PolicySnapshot.empty();
  assertEquals(
    service.decide(makePrincipal("adam"), "read", makeResource()),
    null,
  );
});

// --- Aggregate condition budget ---

Deno.test("decide: normal decision with few conditions unaffected by aggregate budget", () => {
  const grants = Array.from({ length: 5 }, (_, i) =>
    makeGrant({
      subject: { kind: "user", name: "adam" },
      effect: "allow",
      actions: ["read"],
      resource: { kind: "workflow", pattern: "*" },
      condition: `name == "workflow-${i}"`,
    }));
  const matchingGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    condition: 'name == "@acme/deploy"',
  });
  grants.push(matchingGrant);
  const snapshot = new PolicySnapshot(grants, [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result?.effect, "allow");
  assertEquals(result?.grantId, matchingGrant.id);
});

Deno.test("decide: denies when aggregate condition budget exceeded", () => {
  const grants = Array.from(
    { length: MAX_AGGREGATE_CONDITIONS + 1 },
    (_, i) =>
      makeGrant({
        subject: { kind: "user", name: "adam" },
        effect: "allow",
        actions: ["read"],
        resource: { kind: "workflow", pattern: "*" },
        condition: `name == "no-match-${i}"`,
      }),
  );
  const snapshot = new PolicySnapshot(grants, [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result?.effect, "deny");
  assertEquals(result?.grantId, "aggregate-budget-exceeded");
});

Deno.test("decide: grants without conditions do not count toward aggregate budget", () => {
  const conditionlessGrants = Array.from(
    { length: MAX_AGGREGATE_CONDITIONS + 50 },
    () =>
      makeGrant({
        subject: { kind: "user", name: "adam" },
        effect: "allow",
        actions: ["read"],
        resource: { kind: "workflow", pattern: "no-match-*" },
      }),
  );
  const matchingGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  conditionlessGrants.push(matchingGrant);
  const snapshot = new PolicySnapshot(conditionlessGrants, [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "read", makeResource());
  assertEquals(result?.effect, "allow");
});

Deno.test("explain: truncates when aggregate condition budget exceeded", () => {
  const matchingGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    condition: 'name == "@acme/deploy"',
  });
  const nonMatchingGrants = Array.from(
    { length: MAX_AGGREGATE_CONDITIONS + 10 },
    (_, i) =>
      makeGrant({
        subject: { kind: "user", name: "adam" },
        effect: "allow",
        actions: ["read"],
        resource: { kind: "workflow", pattern: "*" },
        condition: `name == "no-match-${i}"`,
      }),
  );
  const grants = [matchingGrant, ...nonMatchingGrants];
  const snapshot = new PolicySnapshot(grants, [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.explain(makePrincipal("adam"), "read", makeResource());
  assertEquals(
    result.length,
    1,
    "matching grant before budget should be included",
  );
  assertEquals(result[0].grantId, matchingGrant.id);
});
