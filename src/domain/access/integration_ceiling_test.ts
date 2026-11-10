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
import type {
  AccessPrincipal,
  AccessResource,
} from "./access_decision_service.ts";
import { Ceiling } from "./ceiling.ts";
import {
  DELEGATION_CEILING_GRANT_ID,
  DELEGATION_ENDED_GRANT_ID,
  DELEGATION_REQUIRED_GRANT_ID,
  GrantBasedAccessDecisionService,
  type GrantBasedAccessDecisionServiceOptions,
  INTEGRATION_CEILING_GRANT_ID,
  INTEGRATION_REVOKED_GRANT_ID,
  INTEGRATION_UNKNOWN_GRANT_ID,
  isConsentRefusal,
} from "./grant_based_access_decision_service.ts";
import type { IntegrationStanding } from "./integration_directory.ts";
import { createConditionEvaluator } from "./policy_snapshot_loader.ts";
import { PolicySnapshot } from "./policy_snapshot.ts";
import type { DelegationRecord } from "../models/access/delegation_model.ts";

function grant(
  actions: Grant["actions"],
  kind: Grant["resource"]["kind"],
  pattern: string,
): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "alice" },
    effect: "allow",
    actions,
    resource: { kind, pattern },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: new Date(0).toISOString(),
  };
}

const ADMIN = grant(["admin"], "access", "*");

const ALICE: AccessPrincipal = {
  principal: { kind: "user", id: "alice" },
  collectives: [],
  groups: [],
  client: "integration:app",
  delegation: "d",
};

const DEPLOY: AccessResource = {
  kind: "workflow",
  name: "deploy",
  fields: { name: "deploy" },
};

const ADMIN_RESOURCE: AccessResource = {
  kind: "access",
  name: "*",
  fields: {},
};

function ceiling(actions: string[], resource = "workflow:deploy"): Ceiling {
  return Ceiling.parse({ version: 1, ceiling: [{ actions, resource }] });
}

function service(
  grants: Grant[],
  standing: IntegrationStanding,
  options: GrantBasedAccessDecisionServiceOptions = {},
): GrantBasedAccessDecisionService {
  return new GrantBasedAccessDecisionService(
    new PolicySnapshot(grants, [], createConditionEvaluator()),
    {
      // a delegation that consented to everything, so the live ceiling decides
      delegations: {
        standingOf: () => ({
          kind: "standing",
          ceiling: Ceiling.parse({
            version: 1,
            ceiling: [{
              actions: ["approve", "read", "run", "signal"],
              resource: "workflow:*",
            }],
          }),
        }),
        recordOf: () => ({ integrationId: "app" }) as DelegationRecord,
      },
      ...options,
      integrations: { standingOf: () => standing },
    },
  );
}

const active = (c: Ceiling): IntegrationStanding => ({
  kind: "active",
  ceiling: c,
});

Deno.test("decide: a request above the ceiling is refused though grants allow it, and one within both is allowed", () => {
  const s = service(
    [grant(["run", "read"], "workflow", "*")],
    active(ceiling(["read"])),
  );
  assertEquals(s.decide(ALICE, "read", DEPLOY)?.effect, "allow");
  const refused = s.decide(ALICE, "run", DEPLOY);
  assertEquals(refused?.effect, "deny");
  assertEquals(refused?.grantId, INTEGRATION_CEILING_GRANT_ID);
});

Deno.test("decide: a ceiling adds nothing a person's grants don't give", () => {
  const s = service([], active(ceiling(["read"])));
  assertEquals(s.decide(ALICE, "read", DEPLOY), null);
  assertEquals(s.decide(ALICE, "admin", ADMIN_RESOURCE)?.effect, "deny");
});

Deno.test("decide: an admin person with an empty ceiling gets an explicit deny, not a null to fall back on", () => {
  const s = service([ADMIN], active(Ceiling.empty()));
  const decision = s.decide(ALICE, "admin", ADMIN_RESOURCE);
  assertEquals(decision?.effect, "deny");
  assertEquals(decision?.grantId, INTEGRATION_CEILING_GRANT_ID);
  assertEquals(s.decide(ALICE, "read", DEPLOY)?.effect, "deny");
});

Deno.test("decide: rights a person has only as an admin aren't available within a ceiling", () => {
  const s = service([ADMIN], active(ceiling(["read"])));
  assertEquals(s.decide(ALICE, "read", DEPLOY), null);
  assertEquals(s.decide(ALICE, "admin", ADMIN_RESOURCE)?.effect, "deny");
});

Deno.test("decide: a ceiling allowing only run doesn't allow approve or signal", () => {
  const s = service(
    [grant(["run", "approve", "signal"], "workflow", "*")],
    active(ceiling(["run"])),
  );
  assertEquals(s.decide(ALICE, "run", DEPLOY)?.effect, "allow");
  assertEquals(s.decide(ALICE, "approve", DEPLOY)?.effect, "deny");
  assertEquals(s.decide(ALICE, "signal", DEPLOY)?.effect, "deny");
});

Deno.test("decide: a person's implied approve passes a ceiling that names approve", () => {
  const grants = [grant(["run"], "workflow", "*")];
  const implied = service(grants, active(ceiling(["approve"])))
    .decide(ALICE, "approve", DEPLOY);
  assertEquals(implied?.effect, "allow");
  assertEquals(implied?.impliedBy, "run");
  assertEquals(
    service(grants, active(ceiling(["approve"])), { runImpliesApprove: false })
      .decide(ALICE, "approve", DEPLOY),
    null,
  );
});

Deno.test("decide: a person's deny still wins within the ceiling", () => {
  const deny: Grant = { ...grant(["run"], "workflow", "*"), effect: "deny" };
  const s = service(
    [deny, grant(["approve"], "workflow", "*")],
    active(ceiling(["approve"])),
  );
  assertEquals(s.decide(ALICE, "approve", DEPLOY)?.effect, "deny");
});

Deno.test("decide: the widest ceiling allowed never reaches another kind or a control-plane record", () => {
  const wide = Ceiling.parse({
    version: 1,
    ceiling: [{
      actions: ["run", "read", "approve", "signal"],
      resource: "workflow:*",
    }],
  });
  const s = service(
    [ADMIN, grant(["run", "read"], "model", "*"), grant(["read"], "data", "*")],
    active(wide),
  );
  for (
    const resource of [
      { kind: "model", name: "m", fields: { name: "m", modelType: "x/y" } },
      { kind: "data", name: "d", fields: { name: "d" } },
      { kind: "vault", name: "v", fields: { name: "v" } },
      {
        kind: "access",
        name: "swamp/integration",
        fields: { name: "n", modelType: "swamp/integration" },
      },
    ] as AccessResource[]
  ) {
    for (const action of ["run", "read"] as const) {
      assertEquals(
        s.decide(ALICE, action, resource)?.grantId,
        INTEGRATION_CEILING_GRANT_ID,
        resource.kind,
      );
    }
  }
  assertEquals(s.hasAnyGrantForKind(ALICE, "read", "model"), false);
});

Deno.test("decide: an unknown or revoked integration, or a malformed client, is refused by name", () => {
  const grants = [ADMIN, grant(["read"], "workflow", "*")];
  assertEquals(
    service(grants, { kind: "unknown" }).decide(ALICE, "read", DEPLOY)?.grantId,
    INTEGRATION_UNKNOWN_GRANT_ID,
  );
  assertEquals(
    service(grants, { kind: "revoked" }).decide(ALICE, "read", DEPLOY)?.grantId,
    INTEGRATION_REVOKED_GRANT_ID,
  );
  assertEquals(
    service(grants, active(Ceiling.empty())).decide(
      { ...ALICE, client: "agent:x" },
      "read",
      DEPLOY,
    )?.grantId,
    INTEGRATION_UNKNOWN_GRANT_ID,
  );
  const noDirectory = new GrantBasedAccessDecisionService(
    new PolicySnapshot(grants, [], createConditionEvaluator()),
  );
  assertEquals(noDirectory.decide(ALICE, "read", DEPLOY)?.effect, "deny");
});

Deno.test("decide: a direct or absent client has no ceiling", () => {
  const s = service([grant(["run"], "workflow", "*")], active(Ceiling.empty()));
  for (const client of [undefined, "direct:cli", "direct:token"]) {
    assertEquals(
      s.decide({ ...ALICE, client, delegation: undefined }, "run", DEPLOY)
        ?.effect,
      "allow",
    );
  }
});

Deno.test("decideAll: needs the ceiling to cover every workflow", () => {
  const grants = [grant(["read"], "workflow", "*")];
  assertEquals(
    service(grants, active(ceiling(["read"]))).decideAll(
      ALICE,
      "read",
      "workflow",
    )
      ?.grantId,
    INTEGRATION_CEILING_GRANT_ID,
  );
  assertEquals(
    service(grants, active(ceiling(["read"], "workflow:*")))
      .decideAll(ALICE, "read", "workflow")?.effect,
    "allow",
  );
});

Deno.test("hasAnyGrantForKind: needs the ceiling to name the action as well as a grant", () => {
  const grants = [grant(["read"], "workflow", "*")];
  assertEquals(
    service(grants, active(ceiling(["read"]))).hasAnyGrantForKind(
      ALICE,
      "read",
      "workflow",
    ),
    true,
  );
  assertEquals(
    service(grants, active(ceiling(["run"]))).hasAnyGrantForKind(
      ALICE,
      "read",
      "workflow",
    ),
    false,
  );
  assertEquals(
    service([], active(ceiling(["read"]))).hasAnyGrantForKind(
      ALICE,
      "read",
      "workflow",
    ),
    false,
  );
});

Deno.test("grantUsableThroughClient: hides a grant the ceiling could never let through", () => {
  const s = service([], active(ceiling(["read"], "workflow:a*")));
  const workflow = grant(["read", "run"], "workflow", "abc");
  assertEquals(s.grantUsableThroughClient(ALICE, workflow, "read"), true);
  assertEquals(s.grantUsableThroughClient(ALICE, workflow, "run"), false);
  assertEquals(
    s.grantUsableThroughClient(ALICE, grant(["read"], "workflow", "z"), "read"),
    false,
  );
  assertEquals(
    s.grantUsableThroughClient(ALICE, grant(["read"], "model", "*"), "read"),
    false,
  );
  assertEquals(
    s.grantUsableThroughClient(
      { ...ALICE, client: undefined, delegation: undefined },
      grant(["read"], "model", "*"),
      "read",
    ),
    true,
  );
});

Deno.test("decide: a request within the live ceiling but outside what the person consented to is refused", () => {
  const s = service(
    [grant(["run", "read"], "workflow", "*")],
    active(ceiling(["run", "read"])),
    {
      delegations: {
        standingOf: () => ({ kind: "standing", ceiling: ceiling(["read"]) }),
        recordOf: () => ({ integrationId: "app" }) as DelegationRecord,
      },
    },
  );
  assertEquals(s.decide(ALICE, "read", DEPLOY)?.effect, "allow");
  const refused = s.decide(ALICE, "run", DEPLOY);
  assertEquals(refused?.grantId, DELEGATION_CEILING_GRANT_ID);
  assertEquals(
    s.grantUsableThroughClient(ALICE, grant(["run"], "workflow", "*"), "run"),
    false,
  );
});

Deno.test("decide: an integration client without a delegation is refused, unless explaining the integration's own ceiling", () => {
  const grants = [grant(["read"], "workflow", "*")];
  const without = { ...ALICE, delegation: undefined };
  const refused = service(grants, active(ceiling(["read"]))).decide(
    without,
    "read",
    DEPLOY,
  );
  assertEquals(refused?.grantId, DELEGATION_REQUIRED_GRANT_ID);
  const explained = service(grants, active(ceiling(["read"])), {
    explainWithoutDelegation: true,
  }).decide(without, "read", DEPLOY);
  assertEquals(explained?.effect, "allow");
});

Deno.test("decide: an ended delegation, or one for another integration, is refused", () => {
  const grants = [grant(["read"], "workflow", "*")];
  const ended = service(grants, active(ceiling(["read"])), {
    delegations: {
      standingOf: () => ({ kind: "ended" }),
      recordOf: () => ({ integrationId: "app" }) as DelegationRecord,
    },
  }).decide(ALICE, "read", DEPLOY);
  assertEquals(ended?.grantId, DELEGATION_ENDED_GRANT_ID);
  const other = service(grants, active(ceiling(["read"])), {
    delegations: {
      standingOf: () => ({ kind: "standing", ceiling: ceiling(["read"]) }),
      recordOf: () => ({ integrationId: "elsewhere" }) as DelegationRecord,
    },
  }).decide(ALICE, "read", DEPLOY);
  assertEquals(other?.grantId, DELEGATION_ENDED_GRANT_ID);
});

Deno.test("decide: a delegated token can't create or edit a workflow, its triggers or a schedule, whatever the person's grants", () => {
  const s = service(
    [
      grant(["read", "write", "run", "approve", "signal"], "workflow", "*"),
      grant(["read", "write", "run"], "model", "*"),
      ADMIN,
    ],
    active(ceiling(["approve", "read", "run", "signal"], "workflow:*")),
  );
  // a workflow's definition holds its triggers and schedules, so write is
  // the only way to make one, and serve.yaml overrides need admin
  assertEquals(s.decide(ALICE, "write", DEPLOY)?.effect, "deny");
  assertEquals(s.decide(ALICE, "admin", ADMIN_RESOURCE)?.effect, "deny");
  assertEquals(
    s.decide(ALICE, "write", { kind: "model", name: "m", fields: {} })
      ?.effect,
    "deny",
  );
  assertEquals(s.decide(ALICE, "run", DEPLOY)?.effect, "allow");
});

Deno.test("isConsentRefusal: only a consented-ceiling refusal that grants alone would allow", () => {
  const consentedRead = {
    delegations: {
      standingOf: () => ({
        kind: "standing" as const,
        ceiling: ceiling(["read"]),
      }),
      recordOf: () => ({ integrationId: "app" }) as DelegationRecord,
    },
  };
  for (const action of ["run", "approve", "signal"] as const) {
    const s = service(
      [grant(["run", "read", "approve", "signal"], "workflow", "*")],
      active(ceiling(["run", "read", "approve", "signal"])),
      consentedRead,
    );
    const refused = s.decide(ALICE, action, DEPLOY);
    assertEquals(isConsentRefusal(s, ALICE, action, DEPLOY, refused), true);
  }
  const noGrant = service(
    [grant(["read"], "workflow", "*")],
    active(ceiling(["run", "read"])),
    consentedRead,
  );
  assertEquals(
    isConsentRefusal(
      noGrant,
      ALICE,
      "run",
      DEPLOY,
      noGrant.decide(ALICE, "run", DEPLOY),
    ),
    false,
  );
  const aboveLive = service(
    [grant(["run", "read"], "workflow", "*")],
    active(ceiling(["read"])),
    consentedRead,
  );
  const refused = aboveLive.decide(ALICE, "run", DEPLOY);
  assertEquals(refused?.grantId, INTEGRATION_CEILING_GRANT_ID);
  assertEquals(
    isConsentRefusal(aboveLive, ALICE, "run", DEPLOY, refused),
    false,
  );
  const consentedAll = {
    delegations: {
      standingOf: () => ({
        kind: "standing" as const,
        ceiling: ceiling(["read", "run"]),
      }),
      recordOf: () => ({ integrationId: "app" }) as DelegationRecord,
    },
  };
  const readAllowed = service(
    [grant(["read"], "workflow", "*")],
    active(ceiling(["read"])),
    consentedAll,
  );
  assertEquals(
    isConsentRefusal(
      readAllowed,
      ALICE,
      "read",
      DEPLOY,
      readAllowed.decide(ALICE, "read", DEPLOY),
    ),
    false,
  );
});
