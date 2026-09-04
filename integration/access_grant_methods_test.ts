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
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type {
  AccessPrincipal,
  AccessResource,
} from "../src/domain/access/access_decision_service.ts";
import { GrantBasedAccessDecisionService } from "../src/domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import { evaluateGrantCondition } from "../src/infrastructure/cel/grant_condition_environment.ts";
import { parseGrantFile } from "../src/domain/access/grant_file.ts";
import { validateGrantCondition } from "../src/infrastructure/cel/grant_condition_environment.ts";

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "monitor" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "model", pattern: "@acme/my-model" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makePrincipal(id: string): AccessPrincipal {
  return { principal: { kind: "user", id }, collectives: [], groups: [] };
}

function makeModelResource(
  name: string,
  methodName?: string,
): AccessResource {
  const fields: Record<string, unknown> = {
    name,
    modelType: "test/model",
    tags: {},
    collective: "",
  };
  if (methodName !== undefined) {
    fields.methodName = methodName;
  }
  return { kind: "model", name, fields };
}

function buildService(grants: Grant[]): GrantBasedAccessDecisionService {
  const snapshot = new PolicySnapshot(grants, [], evaluateGrantCondition);
  return new GrantBasedAccessDecisionService(snapshot);
}

Deno.test("integration: grant file with methods parses and authorizes correctly", () => {
  const yaml = `
grants:
  - subject: "user:monitor"
    effect: allow
    actions: [run]
    resource: "model:@acme/my-model"
    methods: [read, list]
`;
  const result = parseGrantFile("ops.yaml", yaml, validateGrantCondition);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries.length, 1);
  assertEquals(result.entries[0].methods, ["read", "list"]);

  const grant = makeGrant({
    methods: result.entries[0].methods,
    resource: result.entries[0].resource,
  });
  const service = buildService([grant]);

  const allowed = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "read"),
  );
  assertEquals(allowed?.effect, "allow");

  const denied = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "create"),
  );
  assertEquals(denied, null);
});

Deno.test("integration: methods-scoped grant allows matching method", () => {
  const grant = makeGrant({ methods: ["read"] });
  const service = buildService([grant]);

  const result = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "read"),
  );
  assertEquals(result?.effect, "allow");
});

Deno.test("integration: methods-scoped grant denies non-matching method", () => {
  const grant = makeGrant({ methods: ["read"] });
  const service = buildService([grant]);

  const result = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "create"),
  );
  assertEquals(result, null);
});

Deno.test("integration: grant without methods allows any method", () => {
  const grant = makeGrant();
  const service = buildService([grant]);

  for (const method of ["read", "create", "destroy", "custom-method"]) {
    const result = service.decide(
      makePrincipal("monitor"),
      "run",
      makeModelResource("@acme/my-model", method),
    );
    assertEquals(
      result?.effect,
      "allow",
      `expected allow for method ${method}`,
    );
  }
});

Deno.test("integration: CEL condition on methodName evaluates through full pipeline", () => {
  const grant = makeGrant({
    condition: 'methodName == "read"',
  });
  const service = buildService([grant]);

  const allowed = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "read"),
  );
  assertEquals(allowed?.effect, "allow");

  const denied = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "create"),
  );
  assertEquals(denied, null);
});

Deno.test("integration: CEL methodName condition with absent field does not throw", () => {
  const grant = makeGrant({
    condition: 'methodName == "read"',
  });
  const service = buildService([grant]);

  const result = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model"),
  );
  assertEquals(result, null);
});

Deno.test("integration: methods field and CEL condition compose correctly", () => {
  const grant = makeGrant({
    methods: ["read", "list"],
    condition: 'modelType == "test/model"',
  });
  const service = buildService([grant]);

  const allowed = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "read"),
  );
  assertEquals(allowed?.effect, "allow");

  const methodDenied = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "create"),
  );
  assertEquals(methodDenied, null);

  const wrongType = makeGrant({
    methods: ["read"],
    condition: 'modelType == "other/type"',
  });
  const service2 = buildService([wrongType]);
  const conditionDenied = service2.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "read"),
  );
  assertEquals(conditionDenied, null);
});

Deno.test("integration: deny grant with methods blocks specific method", () => {
  const denyGrant = makeGrant({
    effect: "deny",
    methods: ["destroy"],
  });
  const allowGrant = makeGrant();
  const service = buildService([denyGrant, allowGrant]);

  const blocked = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "destroy"),
  );
  assertEquals(blocked?.effect, "deny");

  const allowed = service.decide(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "read"),
  );
  assertEquals(allowed?.effect, "allow");
});

Deno.test("integration: explain path respects methods filtering", () => {
  const grant = makeGrant({ methods: ["read"] });
  const service = buildService([grant]);

  const matching = service.explain(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "read"),
  );
  assertEquals(matching.length, 1);

  const nonMatching = service.explain(
    makePrincipal("monitor"),
    "run",
    makeModelResource("@acme/my-model", "create"),
  );
  assertEquals(nonMatching.length, 0);
});
