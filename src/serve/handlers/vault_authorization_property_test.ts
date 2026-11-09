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
import {
  type AccessResource,
  kindResource,
} from "../../domain/access/access_decision_service.ts";
import type { Action } from "../../domain/access/action.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import {
  createConditionEvaluator,
  type PolicySnapshotLoader,
} from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  type ResourceKind,
  resourceSelectorMatches,
} from "../../domain/access/resource_selector.ts";
import { VAULT_METHODS } from "../../domain/access/access_resources.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import type { AuditEmitter } from "../../domain/serve_audit/audit_emitter.ts";
import {
  authorizeOrReject,
  authorizeVaultOrReject,
  type ConnectionContext,
  vaultAccessResource,
  vaultKindResource,
  type VaultRequest,
} from "./shared.ts";

const CALLER: Principal = { kind: "user", id: "editor" };
const VAULT_NAMES = ["prod-db", "dev-db", "vault"] as const;
const PATTERNS = ["*", "vault", "prod-db", "prod-*", "dev-db", "dev-*"];
const ACTIONS: Action[] = ["read", "write", "admin"];

function socket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
    close() {},
  } as unknown as WebSocket & { sent: string[] };
}

function contextFor(
  grants: Grant[],
  events: unknown[],
): ConnectionContext {
  return {
    repoDir: "/nonexistent",
    instanceId: "test",
    authConfig: {
      mode: "token" as const,
      admins: [],
      allowedCollectives: [],
      allowedUsers: [],
      oauthProvider: "",
      groupsField: "collectives",
      restrictedModelTypes: [],
      restrictedCommands: [],
      approveRequiresExplicitGrant: false,
    },
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
      ),
    } as unknown as PolicySnapshotLoader,
    auditEmitter: {
      emit: (event: Record<string, unknown>) => {
        const { id: _id, timestamp: _timestamp, ...rest } = event;
        events.push(rest);
      },
    } as unknown as AuditEmitter,
  } as unknown as ConnectionContext;
}

interface Run {
  allowed: boolean;
  sent: string[];
  events: unknown[];
}

function runToday(grants: Grant[], request: VaultRequest): Run {
  const events: unknown[] = [];
  const s = socket();
  const { allowed } = authorizeOrReject(
    s,
    "req",
    CALLER,
    request.action,
    request.existing,
    contextFor(grants, events),
  );
  return { allowed, sent: s.sent, events };
}

function runVault(grants: Grant[], request: VaultRequest): Run {
  const events: unknown[] = [];
  const s = socket();
  const { allowed } = authorizeVaultOrReject(
    s,
    "req",
    CALLER,
    request,
    contextFor(grants, events),
  );
  return { allowed, sent: s.sent, events };
}

function decisionOn(
  grants: Grant[],
  action: Action,
  resource: AccessResource,
) {
  return new GrantBasedAccessDecisionService(
    new PolicySnapshot(grants, [], createConditionEvaluator()),
  ).decide(
    {
      principal: CALLER,
      collectives: [],
      groups: [],
      client: undefined,
      delegation: undefined,
    },
    action,
    resource,
  );
}

function deniedByVaultNames(grants: Grant[], request: VaultRequest): boolean {
  return [
    vaultAccessResource("vault"),
    vaultAccessResource(request.vaultName),
    vaultKindResource(request.vaultName, request.key, request.method),
  ].some((resource) =>
    decisionOn(grants, request.action, resource)?.effect === "deny"
  );
}

const arbAction = fc.constantFrom(...ACTIONS);

function arbGrant(kinds: ResourceKind[]): fc.Arbitrary<Grant> {
  return fc.record({
    subject: fc.constantFrom("editor", "editor", "someone-else"),
    effect: fc.constantFrom("allow" as const, "deny" as const),
    actions: fc.uniqueArray(arbAction, { minLength: 1, maxLength: 3 }),
    kind: fc.constantFrom(...kinds),
    pattern: fc.constantFrom(...PATTERNS),
    condition: fc.constantFrom(
      undefined,
      undefined,
      'name == "prod-db"',
      'key == "api"',
    ),
    methods: fc.constantFrom(
      undefined,
      undefined,
      ["put"],
      ["get", "describe"],
    ),
  }).map(({ subject, effect, actions, kind, pattern, condition, methods }) => ({
    id: crypto.randomUUID(),
    subject: { kind: "user" as const, name: subject },
    effect,
    actions,
    resource: {
      kind,
      pattern: kind === "access" || kind === "model" ? "*" : pattern,
    },
    ...(condition && (kind === "vault" || !condition.startsWith("key"))
      ? { condition }
      : {}),
    ...(methods ? { methods } : {}),
    state: "active" as const,
    source: "method" as const,
    createdBy: { kind: "user" as const, id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  }));
}

const arbRequest: fc.Arbitrary<VaultRequest> = fc.record({
  vaultName: fc.constantFrom(...VAULT_NAMES),
  action: arbAction,
  existingKind: fc.constantFrom("all-vaults", "named", "model-admin"),
  key: fc.constantFrom(undefined, "api", "other"),
  method: fc.constantFrom(...VAULT_METHODS),
}).map(({ vaultName, action, existingKind, key, method }) => {
  if (existingKind === "model-admin") {
    return {
      vaultName,
      action: "admin",
      method,
      existing: kindResource("model"),
    };
  }
  const existing = existingKind === "all-vaults"
    ? vaultAccessResource("vault")
    : vaultAccessResource(vaultName);
  return { vaultName, action, method, existing, ...(key ? { key } : {}) };
});

const SEED_GRANT: Grant = {
  id: "seed",
  subject: { kind: "user", name: CALLER.id },
  effect: "allow",
  actions: ["read"],
  resource: { kind: "vault", pattern: "*" },
  state: "active",
  source: "method",
  createdBy: { kind: "user", id: "admin" },
  createdAt: "2026-01-01T00:00:00Z",
};

const NON_VAULT_KINDS: ResourceKind[] = ["data", "model", "access"];
const ALL_KINDS: ResourceKind[] = ["data", "model", "access", "vault"];

Deno.test("authorizeVaultOrReject: without vault grants it decides as today, plus refusals from denies on the vault's data names", () => {
  fc.assert(
    fc.property(
      fc.array(arbGrant(NON_VAULT_KINDS), { maxLength: 6 }),
      arbRequest,
      (grants, request) => {
        const today = runToday(grants, request);
        const now = runVault(grants, request);
        if (!today.allowed) {
          assertEquals(now, today);
          return;
        }
        assertEquals(now.allowed, !deniedByVaultNames(grants, request));
        if (now.allowed) assertEquals(now.sent, []);
      },
    ),
    { numRuns: 1000 },
  );
});

Deno.test("authorizeVaultOrReject: vault grants add allows only from a matching vault allow, and refusals only from matching denies", () => {
  fc.assert(
    fc.property(
      fc.array(arbGrant(ALL_KINDS), { maxLength: 6 }),
      arbRequest,
      fc.boolean(),
      (generated, request, seedVaultAllow) => {
        const grants = seedVaultAllow
          ? [
            ...generated,
            {
              ...SEED_GRANT,
              actions: [request.action],
              resource: { kind: "vault" as const, pattern: request.vaultName },
            },
          ]
          : generated;
        const withoutVault = grants.filter((g) => g.resource.kind !== "vault");
        const today = runToday(withoutVault, request);
        const now = runVault(grants, request);
        const vaultDecision = decisionOn(
          grants,
          request.action,
          vaultKindResource(request.vaultName, request.key, request.method),
        );
        if (now.allowed) {
          assert(today.allowed || vaultDecision?.effect === "allow");
          assert(!deniedByVaultNames(grants, request));
        } else if (today.allowed) {
          assert(deniedByVaultNames(grants, request));
        }
        const matching = grants.filter((g) =>
          g.resource.kind !== "vault" ||
          resourceSelectorMatches(g.resource, request.vaultName)
        );
        assertEquals(runVault(matching, request), now);
      },
    ),
    { numRuns: 1000 },
  );
});

Deno.test("authorizeVaultOrReject: with vaultGrantAdmits false only today's check admits, and denies on the vault's names still refuse", () => {
  fc.assert(
    fc.property(
      fc.array(arbGrant(ALL_KINDS), { maxLength: 6 }),
      arbRequest,
      (generated, base) => {
        const request: VaultRequest = { ...base, vaultGrantAdmits: false };
        const grants = [
          ...generated,
          {
            ...SEED_GRANT,
            actions: [request.action],
            resource: { kind: "vault" as const, pattern: request.vaultName },
          },
        ];
        const withoutVault = grants.filter((g) => g.resource.kind !== "vault");
        const today = runToday(withoutVault, request);
        const now = runVault(grants, request);
        if (!today.allowed) {
          assertEquals(now, today);
          return;
        }
        assertEquals(now.allowed, !deniedByVaultNames(grants, request));
      },
    ),
    { numRuns: 1000 },
  );
});

Deno.test("authorizeVaultOrReject: a vault grant scoped to some verbs admits exactly those verbs, and a scoped deny refuses exactly those", () => {
  fc.assert(
    fc.property(
      fc.subarray([...VAULT_METHODS]),
      arbRequest,
      fc.constantFrom("allow" as const, "deny" as const),
      (methods, base, effect) => {
        const request: VaultRequest = {
          ...base,
          existing: vaultAccessResource("vault"),
        };
        const scoped: Grant = {
          ...SEED_GRANT,
          effect,
          actions: [request.action],
          resource: { kind: "vault", pattern: request.vaultName },
          methods,
        };
        const unscoped: Grant = {
          ...SEED_GRANT,
          id: "unscoped",
          actions: [request.action],
          resource: { kind: "vault", pattern: request.vaultName },
        };
        const grants = effect === "allow" ? [scoped] : [scoped, unscoped];
        const named = methods.length === 0 ||
          (methods as string[]).includes(request.method);
        const now = runVault(grants, request);
        assertEquals(now.allowed, effect === "allow" ? named : !named);
      },
    ),
    { numRuns: 1000 },
  );
});
