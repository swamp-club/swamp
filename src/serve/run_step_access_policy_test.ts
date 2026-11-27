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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../domain/access/policy_snapshot.ts";
import { createConditionEvaluator } from "../domain/access/policy_snapshot_loader.ts";
import type { Grant } from "../domain/models/access/grant_model.ts";
import type { StepAccessTarget } from "../domain/vaults/run_step_access.ts";
import {
  ServeRunStepPolicy,
  type StepRules,
} from "./run_step_access_policy.ts";
import {
  type RunPrincipalInputs,
  ServeRunVaultPolicy,
} from "./run_vault_access_policy.ts";

function grant(
  subject: string,
  kind: Grant["resource"]["kind"],
  pattern: string,
  actions: Grant["actions"],
  effect: Grant["effect"] = "allow",
): Grant {
  const at = subject.indexOf(":");
  return {
    id: crypto.randomUUID(),
    subject: {
      kind: subject.slice(0, at) as Grant["subject"]["kind"],
      name: subject.slice(at + 1),
    },
    effect,
    actions,
    resource: { kind, pattern },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const U: RunPrincipalInputs = {
  source: "session",
  principal: { kind: "user", id: "u" },
  idpGroups: [],
  collectives: [],
};

function policyOf(
  grants: Grant[],
  rules: Partial<StepRules> = {},
  inputs: RunPrincipalInputs = U,
): ServeRunStepPolicy {
  const loader = {
    decisionService: new GrantBasedAccessDecisionService(
      new PolicySnapshot(grants, [], createConditionEvaluator()),
    ),
  };
  const stepRules = () => ({
    stepsRequireExplicitGrant: true,
    restrictedModelTypes: [],
    ...rules,
  });
  return new ServeRunStepPolicy(
    { policySnapshotLoader: loader, stepRules },
    new ServeRunVaultPolicy(
      { authMode: "token", policySnapshotLoader: loader },
      inputs,
    ),
  );
}

function behavior(
  name: string,
  extra: Partial<Extract<StepAccessTarget, { kind: "behavior" }>> = {},
): StepAccessTarget {
  return {
    kind: "behavior",
    name,
    modelType: "test/reader",
    tags: {},
    methodName: "read",
    typeExecution: false,
    ...extra,
  };
}

Deno.test("ServeRunStepPolicy: with the setting off every step is allowed and the policy is inactive", async () => {
  const policy = policyOf([], { stepsRequireExplicitGrant: false });
  assertEquals(policy.active(), false);
  assertEquals((await policy.decide(behavior("other"))).allowed, true);
});

Deno.test("ServeRunStepPolicy: a behavior needs run on its name", async () => {
  const policy = policyOf([grant("user:u", "model", "probe-*", ["run"])]);
  assertEquals((await policy.decide(behavior("probe-a"))).allowed, true);
  const refused = await policy.decide(behavior("other"));
  assertEquals(refused.allowed, false);
  assertEquals(refused.reason, "does not have 'run' on model:other");
});

Deno.test("ServeRunStepPolicy: a deny on the behavior wins over a broader allow", async () => {
  const deny = grant("user:u", "model", "other", ["run"], "deny");
  const policy = policyOf([grant("user:u", "model", "*", ["run"]), deny]);
  const refused = await policy.decide(behavior("other"));
  assertEquals(refused.allowed, false);
  assertEquals(refused.grantId, deny.id);
});

Deno.test("ServeRunStepPolicy: a tag-conditioned deny decides on the behavior's tags", async () => {
  const policy = policyOf([
    grant("user:u", "model", "*", ["run"]),
    {
      ...grant("user:u", "model", "*", ["run"], "deny"),
      condition: 'tags.team == "ops"',
    },
  ]);
  assertEquals(
    (await policy.decide(behavior("a", { tags: { team: "dev" } }))).allowed,
    true,
  );
  assertEquals(
    (await policy.decide(behavior("a", { tags: { team: "ops" } }))).allowed,
    false,
  );
});

Deno.test("ServeRunStepPolicy: a type execution needs run on the type too", async () => {
  const policy = policyOf([grant("user:u", "model", "probe-*", ["run"])]);
  const refused = await policy.decide(
    behavior("probe-a", { typeExecution: true }),
  );
  assertEquals(refused.reason, "does not have 'run' on model:test/reader");
});

Deno.test("ServeRunStepPolicy: a restricted type needs admin on access:*", async () => {
  const policy = policyOf(
    [grant("user:u", "model", "*", ["run"])],
    { restrictedModelTypes: ["test/reader"] },
  );
  const refused = await policy.decide(behavior("probe-a"));
  assertEquals(refused.reason, "does not have 'admin' on access:*");
  const admin = policyOf(
    [grant("user:u", "access", "*", ["admin"])],
    { restrictedModelTypes: ["test/reader"] },
  );
  assertEquals((await admin.decide(behavior("probe-a"))).allowed, true);
});

Deno.test("ServeRunStepPolicy: a nested workflow needs run on the workflow", async () => {
  const policy = policyOf([grant("user:u", "workflow", "probe-*", ["run"])]);
  const allowed = await policy.decide({
    kind: "workflow",
    name: "probe-child",
    tags: {},
  });
  assertEquals(allowed.allowed, true);
  const refused = await policy.decide({
    kind: "workflow",
    name: "other-wf",
    tags: {},
  });
  assertEquals(refused.reason, "does not have 'run' on workflow:other-wf");
});

Deno.test("ServeRunStepPolicy: a run with no recorded principal is refused every step", async () => {
  const policy = policyOf(
    [grant("user:u", "model", "*", ["run"])],
    {},
    { source: "missing", label: "an unrecorded principal" },
  );
  const refused = await policy.decide(behavior("probe-a"));
  assertEquals(refused.allowed, false);
  assertStringIncludes(refused.reason, "recorded no triggering principal");
});
