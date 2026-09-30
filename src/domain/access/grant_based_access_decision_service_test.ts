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
import { MAX_AGGREGATE_CONDITIONS } from "../../infrastructure/cel/grant_condition_environment.ts";
import { createConditionEvaluator } from "./policy_snapshot_loader.ts";
import type { Grant } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import {
  type AccessPrincipal,
  type AccessResource,
  kindResource,
} from "./access_decision_service.ts";
import {
  GrantBasedAccessDecisionService,
  SERVICE_TRIGGER_DEFAULT_GRANT_ID,
} from "./grant_based_access_decision_service.ts";
import type { ConditionEvaluator } from "./policy_snapshot.ts";
import { PolicySnapshot } from "./policy_snapshot.ts";

const celEvaluator: ConditionEvaluator = createConditionEvaluator();

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
  assertEquals(result[0].effect, "deny");
});

Deno.test("explain: sorts deny grants before allow grants regardless of input order", () => {
  const allow = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const deny = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "deny",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "@acme/deploy" },
  });
  const snapshot = new PolicySnapshot([allow, deny], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.explain(
    makePrincipal("adam"),
    "run",
    makeResource(),
  );
  assertEquals(result.length, 2);
  assertEquals(result[0].effect, "deny");
  assertEquals(result[0].grantId, deny.id);
  assertEquals(result[1].effect, "allow");
  assertEquals(result[1].grantId, allow.id);
});

Deno.test("explain: preserves relative order within deny and allow buckets", () => {
  const deny1 = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "deny",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "@acme/deploy" },
  });
  const allow1 = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const deny2 = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "deny",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "@acme/*" },
  });
  const allow2 = makeGrant({
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "@acme/*" },
  });
  const snapshot = new PolicySnapshot(
    [deny1, allow1, deny2, allow2],
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.explain(
    makePrincipal("adam"),
    "read",
    makeResource(),
  );
  assertEquals(result.length, 4);
  assertEquals(result[0].grantId, deny1.id);
  assertEquals(result[1].grantId, deny2.id);
  assertEquals(result[2].grantId, allow1.id);
  assertEquals(result[3].grantId, allow2.id);
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

Deno.test("decide: grant with methods matches when methodName is in list", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
    methods: ["read", "list"],
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "@acme/deploy",
    fields: { name: "@acme/deploy", methodName: "read" },
  });
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: grant with methods does not match when methodName is absent from list", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
    methods: ["read", "list"],
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "@acme/deploy",
    fields: { name: "@acme/deploy", methodName: "create" },
  });
  assertEquals(result, null);
});

Deno.test("decide: grant without methods matches all method names", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "@acme/deploy",
    fields: { name: "@acme/deploy", methodName: "create" },
  });
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: grant with empty methods array matches all method names", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
    methods: [],
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "@acme/deploy",
    fields: { name: "@acme/deploy", methodName: "destroy" },
  });
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: grant with methods matches when resource has no methodName", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
    methods: ["read"],
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "@acme/deploy",
    fields: { name: "@acme/deploy" },
  });
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: deny grant with methods blocks matching method", () => {
  const denyGrant = makeGrant({
    effect: "deny",
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
    methods: ["destroy"],
  });
  const allowGrant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
  });
  const snapshot = new PolicySnapshot(
    [denyGrant, allowGrant],
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "@acme/deploy",
    fields: { name: "@acme/deploy", methodName: "destroy" },
  });
  assertEquals(result?.effect, "deny");
});

Deno.test("explain: methods filtering applies in explain path", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
    methods: ["read"],
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const withMatch = service.explain(makePrincipal("adam"), "run", {
    kind: "model",
    name: "@acme/deploy",
    fields: { name: "@acme/deploy", methodName: "read" },
  });
  assertEquals(withMatch.length, 1);

  const noMatch = service.explain(makePrincipal("adam"), "run", {
    kind: "model",
    name: "@acme/deploy",
    fields: { name: "@acme/deploy", methodName: "create" },
  });
  assertEquals(noMatch.length, 0);
});

Deno.test("decide: run grant implies approve — allows approve action", () => {
  const snapshot = new PolicySnapshot(
    [makeGrant({ actions: ["run"] })],
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const result = service.decide(
    makePrincipal("adam"),
    "approve",
    makeResource(),
  );
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: approve-only grant allows approve but not run", () => {
  const snapshot = new PolicySnapshot(
    [makeGrant({ actions: ["approve"] })],
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);

  const approveResult = service.decide(
    makePrincipal("adam"),
    "approve",
    makeResource(),
  );
  assertEquals(approveResult?.effect, "allow");

  const runResult = service.decide(
    makePrincipal("adam"),
    "run",
    makeResource(),
  );
  assertEquals(runResult, null);
});

Deno.test("decide: deny on approve blocks approval even with run grant", () => {
  const snapshot = new PolicySnapshot(
    [
      makeGrant({ actions: ["run"], effect: "allow" }),
      makeGrant({ actions: ["approve"], effect: "deny" }),
    ],
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const result = service.decide(
    makePrincipal("adam"),
    "approve",
    makeResource(),
  );
  assertEquals(result?.effect, "deny");
});

Deno.test("decide: run grant without approve still permits run action", () => {
  const snapshot = new PolicySnapshot(
    [makeGrant({ actions: ["run"] })],
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const result = service.decide(
    makePrincipal("adam"),
    "run",
    makeResource(),
  );
  assertEquals(result?.effect, "allow");
});

Deno.test("explain: run-implies-approve flows through explain", () => {
  const snapshot = new PolicySnapshot(
    [makeGrant({ actions: ["run"] })],
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const results = service.explain(
    makePrincipal("adam"),
    "approve",
    makeResource(),
  );
  assertEquals(results.length, 1);
  assertEquals(results[0].effect, "allow");
});

Deno.test("hasAnyGrantForKind: returns true when user has matching grant", () => {
  const grant = makeGrant({
    actions: ["read"],
    resource: { kind: "model", pattern: "@acme/*" },
  });
  const snapshot = new PolicySnapshot([grant], []);
  const service = new GrantBasedAccessDecisionService(snapshot);
  assertEquals(
    service.hasAnyGrantForKind(makePrincipal("adam"), "read", "model"),
    true,
  );
});

Deno.test("hasAnyGrantForKind: returns false for wrong kind", () => {
  const grant = makeGrant({
    actions: ["read"],
    resource: { kind: "model", pattern: "@acme/*" },
  });
  const snapshot = new PolicySnapshot([grant], []);
  const service = new GrantBasedAccessDecisionService(snapshot);
  assertEquals(
    service.hasAnyGrantForKind(makePrincipal("adam"), "read", "workflow"),
    false,
  );
});

Deno.test("hasAnyGrantForKind: returns false for wrong action", () => {
  const grant = makeGrant({
    actions: ["read"],
    resource: { kind: "model", pattern: "*" },
  });
  const snapshot = new PolicySnapshot([grant], []);
  const service = new GrantBasedAccessDecisionService(snapshot);
  assertEquals(
    service.hasAnyGrantForKind(makePrincipal("adam"), "write", "model"),
    false,
  );
});

Deno.test("hasAnyGrantForKind: returns false for deny-only grants", () => {
  const grant = makeGrant({
    effect: "deny",
    actions: ["read"],
    resource: { kind: "model", pattern: "@secret/*" },
  });
  const snapshot = new PolicySnapshot([grant], []);
  const service = new GrantBasedAccessDecisionService(snapshot);
  assertEquals(
    service.hasAnyGrantForKind(makePrincipal("adam"), "read", "model"),
    false,
  );
});

Deno.test("hasAnyGrantForKind: returns false when no grants exist", () => {
  const snapshot = new PolicySnapshot([], []);
  const service = new GrantBasedAccessDecisionService(snapshot);
  assertEquals(
    service.hasAnyGrantForKind(makePrincipal("adam"), "read", "model"),
    false,
  );
});

Deno.test("hasAnyGrantForKind: matches via group membership", () => {
  const grant = makeGrant({
    subject: { kind: "group", name: "readers" },
    actions: ["read"],
    resource: { kind: "model", pattern: "@acme/*" },
  });
  const group = makeGroup("readers", ["adam"]);
  const snapshot = new PolicySnapshot([grant], [group]);
  const service = new GrantBasedAccessDecisionService(snapshot);
  assertEquals(
    service.hasAnyGrantForKind(makePrincipal("adam"), "read", "model"),
    true,
  );
});

Deno.test("hasAnyGrantForKind: run implies approve", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "workflow", pattern: "@acme/*" },
  });
  const snapshot = new PolicySnapshot([grant], []);
  const service = new GrantBasedAccessDecisionService(snapshot);
  assertEquals(
    service.hasAnyGrantForKind(makePrincipal("adam"), "approve", "workflow"),
    true,
  );
});

// --- Model type fallback matching ---

Deno.test("decide: matches model grant by extension type when instance name does not match", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "@xero/segment/*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "segment-test-stage-audiences",
    fields: { modelType: "@xero/segment/audience", methodName: "list" },
  });
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: exact extension type grant matches model instance via modelType", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "@xero/segment/audience" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "my-audiences",
    fields: { modelType: "@xero/segment/audience" },
  });
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: deny grant on extension type blocks model instance", () => {
  const denyGrant = makeGrant({
    effect: "deny",
    actions: ["run"],
    resource: { kind: "model", pattern: "@xero/segment/*" },
  });
  const allowGrant = makeGrant({
    effect: "allow",
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
  });
  const snapshot = new PolicySnapshot(
    [denyGrant, allowGrant],
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "segment-test-audiences",
    fields: { modelType: "@xero/segment/audience" },
  });
  assertEquals(result?.effect, "deny");
});

Deno.test("decide: model grant by instance name still works (primary match)", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "my-model-instance" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "my-model-instance",
    fields: { modelType: "@acme/some-type" },
  });
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: model type fallback does not apply to non-model resources", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "workflow", pattern: "@acme/deploy" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "workflow",
    name: "some-other-name",
    fields: { modelType: "@acme/deploy" },
  });
  assertEquals(result, null);
});

Deno.test("decide: model type fallback does not match when modelType is absent", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "@xero/segment/*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const result = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "segment-test-audiences",
    fields: {},
  });
  assertEquals(result, null);
});

Deno.test("decide: method-scoped grant matches model instance via extension type", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "@xero/segment/*" },
    methods: ["list", "search"],
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const allowed = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "segment-audiences",
    fields: { modelType: "@xero/segment/audience", methodName: "list" },
  });
  assertEquals(allowed?.effect, "allow");

  const denied = service.decide(makePrincipal("adam"), "run", {
    kind: "model",
    name: "segment-audiences",
    fields: { modelType: "@xero/segment/audience", methodName: "delete" },
  });
  assertEquals(denied, null);
});

Deno.test("explain: includes model type fallback matches", () => {
  const grant = makeGrant({
    actions: ["run"],
    resource: { kind: "model", pattern: "@xero/segment/*" },
  });
  const snapshot = new PolicySnapshot([grant], [], celEvaluator);
  const service = new GrantBasedAccessDecisionService(snapshot);

  const decisions = service.explain(makePrincipal("adam"), "run", {
    kind: "model",
    name: "segment-test-audiences",
    fields: { modelType: "@xero/segment/audience" },
  });
  assertEquals(decisions.length, 1);
  assertEquals(decisions[0].effect, "allow");
});

// --- runImpliesApprove: false (approve requires an explicit grant) ---

function strictService(
  grants: Grant[],
  groups: Group[] = [],
): GrantBasedAccessDecisionService {
  return new GrantBasedAccessDecisionService(
    new PolicySnapshot(grants, groups, celEvaluator),
    { runImpliesApprove: false },
  );
}

Deno.test("runImpliesApprove: defaults to true", () => {
  const service = new GrantBasedAccessDecisionService(PolicySnapshot.empty());
  assertEquals(service.runImpliesApprove, true);
});

Deno.test("decide: run grant does not imply approve when runImpliesApprove is false", () => {
  const service = strictService([makeGrant({ actions: ["run"] })]);
  assertEquals(service.runImpliesApprove, false);
  assertEquals(
    service.decide(makePrincipal("adam"), "approve", makeResource()),
    null,
  );
});

Deno.test("decide: run grant still permits run when runImpliesApprove is false", () => {
  const service = strictService([makeGrant({ actions: ["run"] })]);
  assertEquals(
    service.decide(makePrincipal("adam"), "run", makeResource())?.effect,
    "allow",
  );
});

Deno.test("decide: explicit approve grant allows approve when runImpliesApprove is false", () => {
  const service = strictService([
    makeGrant({ actions: ["run"] }),
    makeGrant({ actions: ["approve"] }),
  ]);
  const result = service.decide(
    makePrincipal("adam"),
    "approve",
    makeResource(),
  );
  assertEquals(result?.effect, "allow");
  assertEquals(result?.impliedBy, undefined);
});

Deno.test("decide: deny on run still denies approve when runImpliesApprove is false", () => {
  const service = strictService([
    makeGrant({ actions: ["approve"], effect: "allow" }),
    makeGrant({ actions: ["run"], effect: "deny" }),
  ]);
  const result = service.decide(
    makePrincipal("adam"),
    "approve",
    makeResource(),
  );
  assertEquals(result?.effect, "deny");
  assertEquals(result?.impliedBy, "run");
});

Deno.test("decide: group run grant does not imply approve when runImpliesApprove is false", () => {
  const service = strictService(
    [
      makeGrant({
        subject: { kind: "group", name: "swamp-lanes" },
        actions: ["run", "read"],
      }),
    ],
    [makeGroup("swamp-lanes", ["swamp-resumer"])],
  );
  assertEquals(
    service.decide(makePrincipal("swamp-resumer"), "approve", makeResource()),
    null,
  );
});

Deno.test("decide: marks an approve allowed through a run grant as impliedBy run", () => {
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot([makeGrant({ actions: ["run"] })], [], celEvaluator),
  );
  assertEquals(
    service.decide(makePrincipal("adam"), "approve", makeResource())
      ?.impliedBy,
    "run",
  );
  assertEquals(
    service.decide(makePrincipal("adam"), "run", makeResource())?.impliedBy,
    undefined,
  );
});

Deno.test("explain: omits run-only allow grants for approve when runImpliesApprove is false", () => {
  const service = strictService([
    makeGrant({ actions: ["run"] }),
    makeGrant({ actions: ["run"], effect: "deny" }),
  ]);
  const results = service.explain(
    makePrincipal("adam"),
    "approve",
    makeResource(),
  );
  assertEquals(results.length, 1);
  assertEquals(results[0].effect, "deny");
  assertEquals(results[0].impliedBy, "run");
});

Deno.test("explain: marks implied and explicit approve decisions", () => {
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot(
      [makeGrant({ actions: ["run"] }), makeGrant({ actions: ["approve"] })],
      [],
      celEvaluator,
    ),
  );
  const results = service.explain(
    makePrincipal("adam"),
    "approve",
    makeResource(),
  );
  assertEquals(results.map((d) => d.impliedBy), ["run", undefined]);
});

Deno.test("actionsCoveredBy: appends approve implied by an allow run grant", () => {
  const service = new GrantBasedAccessDecisionService(PolicySnapshot.empty());
  assertEquals(
    service.actionsCoveredBy(makeGrant({ actions: ["run", "read"] })),
    [{ action: "run" }, { action: "read" }, {
      action: "approve",
      impliedBy: "run",
    }],
  );
});

Deno.test("actionsCoveredBy: does not duplicate an explicit approve", () => {
  const service = new GrantBasedAccessDecisionService(PolicySnapshot.empty());
  assertEquals(
    service.actionsCoveredBy(makeGrant({ actions: ["run", "approve"] })),
    [{ action: "run" }, { action: "approve" }],
  );
});

Deno.test("actionsCoveredBy: omits implied approve for allow grants when runImpliesApprove is false", () => {
  const service = strictService([]);
  assertEquals(
    service.actionsCoveredBy(makeGrant({ actions: ["run", "read"] })),
    [{ action: "run" }, { action: "read" }],
  );
});

Deno.test("actionsCoveredBy: keeps implied approve for deny grants when runImpliesApprove is false", () => {
  const service = strictService([]);
  assertEquals(
    service.actionsCoveredBy(makeGrant({ actions: ["run"], effect: "deny" })),
    [{ action: "run" }, { action: "approve", impliedBy: "run" }],
  );
});

Deno.test("hasAnyGrantForKind: run does not imply approve when runImpliesApprove is false", () => {
  const service = strictService([
    makeGrant({
      actions: ["run"],
      resource: { kind: "workflow", pattern: "@acme/*" },
    }),
  ]);
  assertEquals(
    service.hasAnyGrantForKind(makePrincipal("adam"), "approve", "workflow"),
    false,
  );
  assertEquals(
    service.hasAnyGrantForKind(makePrincipal("adam"), "run", "workflow"),
    true,
  );
});

function makeServicePrincipal(id: string): AccessPrincipal {
  return { principal: { kind: "service", id }, collectives: [], groups: [] };
}

Deno.test("decide: service principal may run a workflow with no grants", () => {
  const service = new GrantBasedAccessDecisionService(PolicySnapshot.empty());
  const result = service.decide(
    makeServicePrincipal("webhook"),
    "run",
    makeResource(),
  );
  assertEquals(result, {
    effect: "allow",
    grantId: SERVICE_TRIGGER_DEFAULT_GRANT_ID,
    subject: { kind: "service", name: "webhook" },
  });
});

Deno.test("decide: service default covers only run on workflows", () => {
  const service = new GrantBasedAccessDecisionService(PolicySnapshot.empty());
  const scheduler = makeServicePrincipal("scheduler");
  for (const action of ["read", "write", "approve", "admin"] as const) {
    assertEquals(service.decide(scheduler, action, makeResource()), null);
  }
  assertEquals(
    service.decide(scheduler, "run", makeResource({ kind: "model" })),
    null,
  );
});

Deno.test("decide: a deny grant on a service principal beats the default", () => {
  const deny = makeGrant({
    subject: { kind: "service", name: "scheduler" },
    effect: "deny",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "@acme/deploy" },
  });
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot([deny], [], celEvaluator),
  );
  const result = service.decide(
    makeServicePrincipal("scheduler"),
    "run",
    makeResource(),
  );
  assertEquals(result?.effect, "deny");
  assertEquals(result?.grantId, deny.id);
});

Deno.test("decide: a conditioned deny allowlists service runs", () => {
  const deny = makeGrant({
    subject: { kind: "service", name: "webhook" },
    effect: "deny",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
    condition: 'name != "@acme/allowed"',
  });
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot([deny], [], celEvaluator),
  );
  const webhook = makeServicePrincipal("webhook");
  assertEquals(service.decide(webhook, "run", makeResource())?.effect, "deny");
  assertEquals(
    service.decide(
      webhook,
      "run",
      makeResource({
        name: "@acme/allowed",
        fields: { name: "@acme/allowed", tags: {}, collective: "" },
      }),
    )?.grantId,
    SERVICE_TRIGGER_DEFAULT_GRANT_ID,
  );
});

Deno.test("decide: user and worker principals get no service default", () => {
  const service = new GrantBasedAccessDecisionService(PolicySnapshot.empty());
  assertEquals(
    service.decide(makePrincipal("scheduler"), "run", makeResource()),
    null,
  );
  assertEquals(
    service.decide(
      {
        principal: { kind: "worker", id: "scheduler" },
        collectives: [],
        groups: [],
      },
      "run",
      makeResource(),
    ),
    null,
  );
});

Deno.test("explain: reports the service default when no grant matches", () => {
  const service = new GrantBasedAccessDecisionService(PolicySnapshot.empty());
  const decisions = service.explain(
    makeServicePrincipal("scheduler"),
    "run",
    makeResource(),
  );
  assertEquals(decisions.map((d) => d.grantId), [
    SERVICE_TRIGGER_DEFAULT_GRANT_ID,
  ]);
});

Deno.test("explain: omits the service default when a deny matches", () => {
  const deny = makeGrant({
    subject: { kind: "service", name: "scheduler" },
    effect: "deny",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot([deny], [], celEvaluator),
  );
  const decisions = service.explain(
    makeServicePrincipal("scheduler"),
    "run",
    makeResource(),
  );
  assertEquals(decisions.map((d) => d.grantId), [deny.id]);
});

Deno.test("decide: a deny whose condition errors withholds the service default", () => {
  // The workflow has no `trigger` tag, so CEL throws "No such key".
  const deny = makeGrant({
    subject: { kind: "service", name: "webhook" },
    effect: "deny",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
    condition: 'tags.trigger != "webhook"',
  });
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot([deny], [], celEvaluator),
  );
  const webhook = makeServicePrincipal("webhook");
  const untagged = makeResource({
    fields: { name: "@acme/deploy", tags: { env: "prod" }, collective: "" },
  });
  assertEquals(service.decide(webhook, "run", untagged), null);
  assertEquals(service.explain(webhook, "run", untagged), []);

  const tagged = makeResource({
    fields: {
      name: "@acme/deploy",
      tags: { trigger: "webhook" },
      collective: "",
    },
  });
  assertEquals(
    service.decide(webhook, "run", tagged)?.grantId,
    SERVICE_TRIGGER_DEFAULT_GRANT_ID,
  );
});

// --- Missing condition fields (swamp-club#2675) ---

function allowAndConditionalDeny(condition: string): Grant[] {
  return [
    makeGrant({ effect: "allow", resource: { kind: "model", pattern: "*" } }),
    makeGrant({
      effect: "deny",
      resource: { kind: "model", pattern: "*" },
      condition,
    }),
  ];
}

Deno.test("decide: a deny that needs a resource field the resource lacks fails closed", () => {
  const snapshot = new PolicySnapshot(
    allowAndConditionalDeny('tags.env == "prod"'),
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const result = service.decide(makePrincipal("adam"), "read", {
    kind: "model",
    name: "db",
    fields: { name: "db", modelType: "t" },
  });
  assertEquals(result?.effect, "deny");
});

Deno.test("decide: a deny over a tag the resource does not have decides nothing", () => {
  const snapshot = new PolicySnapshot(
    allowAndConditionalDeny('tags.env == "prod"'),
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const result = service.decide(makePrincipal("adam"), "read", {
    kind: "model",
    name: "db",
    fields: { name: "db", modelType: "t", tags: {} },
  });
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: an allow that needs a missing resource field does not match", () => {
  const grant = makeGrant({
    effect: "allow",
    resource: { kind: "model", pattern: "*" },
    condition: 'tags.env == "dev"',
  });
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot([grant], [], celEvaluator),
  );
  const result = service.decide(makePrincipal("adam"), "read", {
    kind: "model",
    name: "db",
    fields: { name: "db" },
  });
  assertEquals(result, null);
});

Deno.test("decide: a methodName deny does not refuse a request that has no method", () => {
  const snapshot = new PolicySnapshot(
    allowAndConditionalDeny('methodName == "delete"'),
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const resource = { kind: "model" as const, name: "db", fields: {} };
  assertEquals(
    service.decide(makePrincipal("adam"), "read", resource)?.effect,
    "allow",
  );
  assertEquals(
    service.decide(makePrincipal("adam"), "run", {
      ...resource,
      fields: { methodName: "delete" },
    }),
    null,
  );
});

Deno.test("decide: evaluates name from the resource when fields omit it", () => {
  const snapshot = new PolicySnapshot(
    [makeGrant({
      effect: "allow",
      resource: { kind: "access", pattern: "*" },
      actions: ["admin"],
      condition: 'name == "*"',
    })],
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const result = service.decide(makePrincipal("adam"), "admin", {
    kind: "access",
    name: "*",
    fields: {},
  });
  assertEquals(result?.effect, "allow");
});

Deno.test("decide: a kind-level check is not refused by a deny on resource fields", () => {
  const snapshot = new PolicySnapshot(
    allowAndConditionalDeny('tags.env == "prod"'),
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const result = service.decide(
    makePrincipal("adam"),
    "read",
    kindResource("model"),
  );
  assertEquals(result?.effect, "allow");
});

Deno.test("explain: reports a deny that fails closed on a missing field", () => {
  const snapshot = new PolicySnapshot(
    allowAndConditionalDeny('tags.env == "prod"'),
    [],
    celEvaluator,
  );
  const service = new GrantBasedAccessDecisionService(snapshot);
  const decisions = service.explain(makePrincipal("adam"), "read", {
    kind: "model",
    name: "db",
    fields: { name: "db" },
  });
  assertEquals(decisions.map((d) => d.effect), ["deny", "allow"]);
});

// --- decideAll ---

Deno.test("decideAll: allows when an allow covers every resource and no deny applies", () => {
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot(
      [
        makeGrant({
          effect: "allow",
          actions: ["write"],
          resource: { kind: "data", pattern: "*" },
        }),
      ],
      [],
      celEvaluator,
    ),
  );
  assertEquals(
    service.decideAll(makePrincipal("adam"), "write", "data")?.effect,
    "allow",
  );
});

Deno.test("decideAll: any applicable deny refuses, whatever its pattern", () => {
  const deny = makeGrant({
    effect: "deny",
    actions: ["write"],
    resource: { kind: "data", pattern: "prod-*" },
  });
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot(
      [
        makeGrant({
          effect: "allow",
          actions: ["write"],
          resource: { kind: "data", pattern: "*" },
        }),
        deny,
      ],
      [],
      celEvaluator,
    ),
  );
  const result = service.decideAll(makePrincipal("adam"), "write", "data");
  assertEquals(result?.effect, "deny");
  assertEquals(result?.grantId, deny.id);
});

Deno.test("decideAll: a deny for another action or kind does not refuse", () => {
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot(
      [
        makeGrant({
          effect: "allow",
          actions: ["write"],
          resource: { kind: "data", pattern: "*" },
        }),
        makeGrant({
          effect: "deny",
          actions: ["read"],
          resource: { kind: "data", pattern: "prod-*" },
        }),
        makeGrant({
          effect: "deny",
          actions: ["write"],
          resource: { kind: "model", pattern: "*" },
        }),
        makeGrant({
          subject: { kind: "user", name: "someone-else" },
          effect: "deny",
          actions: ["write"],
          resource: { kind: "data", pattern: "*" },
        }),
      ],
      [],
      celEvaluator,
    ),
  );
  assertEquals(
    service.decideAll(makePrincipal("adam"), "write", "data")?.effect,
    "allow",
  );
});

Deno.test("decideAll: an allow scoped to some resources does not cover every resource", () => {
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot(
      [
        makeGrant({
          effect: "allow",
          actions: ["write"],
          resource: { kind: "data", pattern: "dev-*" },
        }),
      ],
      [],
      celEvaluator,
    ),
  );
  assertEquals(service.decideAll(makePrincipal("adam"), "write", "data"), null);
});
