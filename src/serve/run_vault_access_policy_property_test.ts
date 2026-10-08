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
import type { AccessPrincipal } from "../domain/access/access_decision_service.ts";
import { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../domain/access/policy_snapshot.ts";
import { resourceSelectorMatches } from "../domain/access/resource_selector.ts";
import type { Grant } from "../domain/models/access/grant_model.ts";
import { isReservedVaultName } from "../domain/vaults/vault_name.ts";
import { decideRunVaultAccess } from "./run_vault_access_policy.ts";

const VAULTS = ["erp", "roomcontrol", "prod-a", "prod-b", "_token-secrets"];
const PATTERNS = ["erp", "roomcontrol", "prod-*", "*", "_token-secrets"];
const ACTIONS = ["read", "write"] as const;
const BOT: AccessPrincipal = {
  principal: { kind: "user", id: "bot" },
  collectives: [],
  groups: [],
};

// Unconditional grants only, so a literal evaluator suffices.
const noConditions = () => false;

const grantArb = (kinds: readonly ("vault" | "data" | "model")[]) =>
  fc.record({
    effect: fc.constantFrom("allow" as const, "deny" as const),
    actions: fc.subarray(["read", "write", "run"] as const, { minLength: 1 }),
    kind: fc.constantFrom(...kinds),
    pattern: fc.constantFrom(...PATTERNS),
    subject: fc.constantFrom("bot", "other"),
  }).map((g): Grant => ({
    id: crypto.randomUUID(),
    subject: { kind: "user", name: g.subject },
    effect: g.effect,
    actions: [...g.actions],
    resource: { kind: g.kind, pattern: g.pattern },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  }));

function service(grants: Grant[]): GrantBasedAccessDecisionService {
  return new GrantBasedAccessDecisionService(
    new PolicySnapshot(grants, [], noConditions),
  );
}

const forBot = (grants: Grant[], effect: "allow" | "deny", action: string) =>
  grants.filter((g) =>
    g.subject.name === "bot" && g.resource.kind === "vault" &&
    g.effect === effect && g.actions.includes(action as Grant["actions"][0])
  );

Deno.test("decideRunVaultAccess (property): with no vault grant every non-reserved vault is allowed", () => {
  fc.assert(
    fc.property(
      fc.array(grantArb(["data", "model"]), { maxLength: 8 }),
      fc.constantFrom(...VAULTS),
      fc.constantFrom(...ACTIONS),
      (grants, vault, action) => {
        const decision = decideRunVaultAccess(
          service(grants),
          BOT,
          vault,
          action,
        );
        assertEquals(decision.allowed, !isReservedVaultName(vault));
      },
    ),
  );
});

Deno.test("decideRunVaultAccess (property): deny-only vault grants refuse exactly the matching vaults", () => {
  fc.assert(
    fc.property(
      fc.array(
        grantArb(["vault"]).map((g) => ({ ...g, effect: "deny" as const })),
        { minLength: 1, maxLength: 6 },
      ),
      fc.constantFrom(...VAULTS.filter((v) => !isReservedVaultName(v))),
      fc.constantFrom(...ACTIONS),
      (grants, vault, action) => {
        const decision = decideRunVaultAccess(
          service(grants),
          BOT,
          vault,
          action,
        );
        const denied = forBot(grants, "deny", action).some((g) =>
          resourceSelectorMatches(g.resource, vault)
        );
        assertEquals(decision.allowed, !denied);
      },
    ),
  );
});

Deno.test("decideRunVaultAccess (property): any vault allow makes every action default-deny outside its patterns", () => {
  fc.assert(
    fc.property(
      fc.array(grantArb(["vault", "data"]), { maxLength: 8 }),
      fc.constantFrom(...VAULTS.filter((v) => !isReservedVaultName(v))),
      fc.constantFrom(...ACTIONS),
      (grants, vault, action) => {
        const scoped = grants.some((g) =>
          g.subject.name === "bot" && g.resource.kind === "vault" &&
          g.effect === "allow"
        );
        fc.pre(scoped);
        const decision = decideRunVaultAccess(
          service(grants),
          BOT,
          vault,
          action,
        );
        const allowed = forBot(grants, "allow", action).some((g) =>
          resourceSelectorMatches(g.resource, vault)
        );
        const denied = forBot(grants, "deny", action).some((g) =>
          resourceSelectorMatches(g.resource, vault)
        );
        assertEquals(decision.allowed, allowed && !denied);
        assert(decision.restricted || !decision.allowed);
      },
    ),
  );
});

Deno.test("decideRunVaultAccess (property): a reserved vault is always refused to a non-admin", () => {
  fc.assert(
    fc.property(
      fc.array(grantArb(["vault", "data", "model"]), { maxLength: 8 }),
      fc.constantFrom(...ACTIONS),
      (grants, action) => {
        const decision = decideRunVaultAccess(
          service(grants),
          BOT,
          "_token-secrets",
          action,
        );
        assertEquals(decision.allowed, false);
        assertEquals(decision.rule, "reserved");
      },
    ),
  );
});
