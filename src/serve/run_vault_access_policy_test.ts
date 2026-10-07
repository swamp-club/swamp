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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { AccessPrincipal } from "../domain/access/access_decision_service.ts";
import { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../domain/access/policy_snapshot.ts";
import { createConditionEvaluator } from "../domain/access/policy_snapshot_loader.ts";
import { SCHEDULER_PRINCIPAL } from "../domain/access/service_principal.ts";
import type { Grant } from "../domain/models/access/grant_model.ts";
import type { Group } from "../domain/models/access/group_model.ts";
import type { ServerToken } from "../domain/models/access/server_token_model.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import {
  runWithVaultAccess,
  VaultAccessDeniedError,
} from "../domain/vaults/run_vault_access.ts";
import {
  createRunVaultScope,
  decideRunVaultAccess,
  resumeRunVaultScope,
  type RunVaultPolicyDeps,
  ServeRunVaultPolicy,
  serviceRunVaultScope,
} from "./run_vault_access_policy.ts";

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "bot" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "vault", pattern: "roomcontrol" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function group(name: string, members: string[]): Group {
  return {
    name,
    members: members.map((id) => ({ kind: "user" as const, id })),
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function service(
  grants: Grant[],
  groups: Group[] = [],
): GrantBasedAccessDecisionService {
  return new GrantBasedAccessDecisionService(
    new PolicySnapshot(grants, groups, createConditionEvaluator()),
  );
}

function user(id = "bot", groups: string[] = []): AccessPrincipal {
  return { principal: { kind: "user", id }, collectives: [], groups };
}

const accessAdmin = (id: string) =>
  grant({
    subject: { kind: "user", name: id },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });

Deno.test("decideRunVaultAccess: with no vault grant every non-reserved vault is allowed", () => {
  const svc = service([
    grant({ resource: { kind: "data", pattern: "vault" } }),
    grant({ effect: "deny", resource: { kind: "data", pattern: "erp" } }),
  ]);
  for (const action of ["read", "write"] as const) {
    const decision = decideRunVaultAccess(svc, user(), "erp", action);
    assertEquals(decision.allowed, true);
    assertEquals(decision.rule, "no-vault-grants");
    assertEquals(decision.restricted, false);
  }
});

Deno.test("decideRunVaultAccess: a reserved vault is refused unless the principal is an access admin", () => {
  const svc = service([accessAdmin("root")]);
  const refused = decideRunVaultAccess(
    svc,
    user(),
    "_token-secrets",
    "read",
  );
  assertEquals(refused.allowed, false);
  assertEquals(refused.rule, "reserved");
  // The reason covers writes as well as reads.
  assertStringIncludes(refused.reason, "usable by a serve run only");
  assertEquals(
    decideRunVaultAccess(svc, user("root"), "_token-secrets", "read").allowed,
    true,
  );
});

Deno.test("decideRunVaultAccess: a vault allow on a reserved vault does not admit a non-admin", () => {
  const svc = service([
    grant({ resource: { kind: "vault", pattern: "*" } }),
  ]);
  const decision = decideRunVaultAccess(
    svc,
    user(),
    "_token-secrets",
    "read",
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.rule, "reserved");
});

Deno.test("decideRunVaultAccess: a deny-only principal loses just the denied vault", () => {
  const deny = grant({
    effect: "deny",
    resource: { kind: "vault", pattern: "erp" },
  });
  const svc = service([deny]);
  const refused = decideRunVaultAccess(svc, user(), "erp", "read");
  assertEquals(refused.allowed, false);
  assertEquals(refused.rule, "vault-deny");
  assertEquals(refused.grantId, deny.id);
  assertEquals(
    refused.reason,
    `denied by grant ${deny.id}; remove or narrow grant ${deny.id} to allow it`,
  );
  const other = decideRunVaultAccess(svc, user(), "roomcontrol", "read");
  assertEquals(other.allowed, true);
  assertEquals(other.rule, "unscoped");
  // A deny for read leaves write alone.
  assertEquals(decideRunVaultAccess(svc, user(), "erp", "write").allowed, true);
});

Deno.test("decideRunVaultAccess: any vault allow scopes the principal for every action", () => {
  const allow = grant();
  const svc = service([allow]);
  const allowed = decideRunVaultAccess(svc, user(), "roomcontrol", "read");
  assertEquals(allowed.allowed, true);
  assertEquals(allowed.rule, "vault-allow");
  assertEquals(allowed.restricted, true);
  assertEquals(allowed.grantId, allow.id);
  const other = decideRunVaultAccess(svc, user(), "erp", "read");
  assertEquals(other.allowed, false);
  assertEquals(other.rule, "vault-scoped");
  assertStringIncludes(other.reason, "vault:erp");
  // The refusal says how to fix it.
  assertStringIncludes(
    other.reason,
    "add a vault:erp allow grant for read to this principal",
  );
  // Read was granted; write on the same vault is not.
  assertEquals(
    decideRunVaultAccess(svc, user(), "roomcontrol", "write").allowed,
    false,
  );
  // Another principal holds no vault grant and is not scoped.
  assertEquals(
    decideRunVaultAccess(svc, user("alice"), "erp", "read").allowed,
    true,
  );
});

Deno.test("decideRunVaultAccess: a vault allow scopes through a local group and an IdP group", () => {
  const svc = service(
    [
      grant({ subject: { kind: "group", name: "bots" } }),
      grant({ subject: { kind: "idp-group", name: "ci" } }),
    ],
    [group("bots", ["bot"])],
  );
  assertEquals(decideRunVaultAccess(svc, user(), "erp", "read").allowed, false);
  assertEquals(
    decideRunVaultAccess(svc, user("carol", ["ci"]), "erp", "read").allowed,
    false,
  );
  assertEquals(
    decideRunVaultAccess(svc, user("carol", ["ci"]), "roomcontrol", "read")
      .allowed,
    true,
  );
});

Deno.test("decideRunVaultAccess: an access admin is never vault-scoped but is refused by a vault deny", () => {
  const svc = service([
    accessAdmin("root"),
    grant({
      subject: { kind: "user", name: "root" },
      resource: { kind: "vault", pattern: "roomcontrol" },
    }),
    grant({
      subject: { kind: "user", name: "root" },
      effect: "deny",
      resource: { kind: "vault", pattern: "erp" },
    }),
  ]);
  const other = decideRunVaultAccess(svc, user("root"), "billing", "read");
  assertEquals(other.allowed, true);
  assertEquals(other.rule, "access-admin");
  const denied = decideRunVaultAccess(svc, user("root"), "erp", "read");
  assertEquals(denied.allowed, false);
  assertEquals(denied.rule, "vault-deny");
});

Deno.test("decideRunVaultAccess: unavailable memberships fail closed only once vault grants exist", () => {
  assertEquals(
    decideRunVaultAccess(service([]), null, "erp", "read").allowed,
    true,
  );
  const decision = decideRunVaultAccess(
    service([grant({ subject: { kind: "user", name: "other" } })]),
    null,
    "erp",
    "read",
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.rule, "membership-unavailable");
});

Deno.test("decideRunVaultAccess: with keyUnknown a refusal that depends on a key condition is undetermined", () => {
  const keyAllow = grant({
    actions: ["read", "write"],
    resource: { kind: "vault", pattern: "outputs" },
    condition: 'key.startsWith("app-")',
  });
  const svc = service([keyAllow]);
  // Evaluated with no key the condition fails, so the scoped bot is refused.
  assertEquals(
    decideRunVaultAccess(svc, user(), "outputs", "write").rule,
    "vault-scoped",
  );
  const undetermined = decideRunVaultAccess(
    svc,
    user(),
    "outputs",
    "write",
    undefined,
    { keyUnknown: true },
  );
  assertEquals(undetermined.allowed, false);
  assertEquals(undetermined.undetermined, true);
  assertEquals(undetermined.rule, "key-undetermined");
  // A known key decides as before.
  assertEquals(
    decideRunVaultAccess(svc, user(), "outputs", "write", "app-token").allowed,
    true,
  );
  assertEquals(
    decideRunVaultAccess(svc, user(), "outputs", "write", "other").allowed,
    false,
  );
  // A vault no key-conditioned grant matches is still refused.
  assertEquals(
    decideRunVaultAccess(svc, user(), "erp", "write", undefined, {
      keyUnknown: true,
    }).rule,
    "vault-scoped",
  );
});

Deno.test("decideRunVaultAccess: with keyUnknown a key-conditioned allow for another action does not defer a refusal", () => {
  const svc = service([
    grant({
      actions: ["read"],
      resource: { kind: "vault", pattern: "outputs" },
      condition: 'key.startsWith("app-")',
    }),
  ]);
  // No key makes a read allow cover a write, so the write is refused now.
  const decision = decideRunVaultAccess(
    svc,
    user(),
    "outputs",
    "write",
    undefined,
    { keyUnknown: true },
  );
  assertEquals(decision.rule, "vault-scoped");
  assertEquals(decision.undetermined, undefined);
  // The read the allow covers is still undetermined without the key.
  assertEquals(
    decideRunVaultAccess(svc, user(), "outputs", "read", undefined, {
      keyUnknown: true,
    }).rule,
    "key-undetermined",
  );
});

Deno.test("decideRunVaultAccess: a key-conditioned deny through an IdP group is undetermined only without the key", () => {
  const svc = service([
    grant({
      actions: ["read", "write"],
      resource: { kind: "vault", pattern: "*" },
    }),
    grant({
      subject: { kind: "idp-group", name: "ci" },
      effect: "deny",
      actions: ["write"],
      resource: { kind: "vault", pattern: "out*" },
      condition: 'key == ""',
    }),
  ]);
  const ci = user("bot", ["ci"]);
  assertEquals(
    decideRunVaultAccess(svc, ci, "outputs", "write").rule,
    "vault-deny",
  );
  assertEquals(
    decideRunVaultAccess(svc, ci, "outputs", "write", undefined, {
      keyUnknown: true,
    }).undetermined,
    true,
  );
  // Without the group the deny does not apply to the principal.
  assertEquals(
    decideRunVaultAccess(svc, user(), "outputs", "write").allowed,
    true,
  );
});

Deno.test("decideRunVaultAccess: with keyUnknown a deny that holds for every key still refuses", () => {
  const deny = grant({
    effect: "deny",
    actions: ["write"],
    resource: { kind: "vault", pattern: "outputs" },
  });
  const svc = service([
    grant({
      actions: ["read", "write"],
      resource: { kind: "vault", pattern: "outputs" },
      condition: 'key.startsWith("app-")',
    }),
    deny,
  ]);
  const decision = decideRunVaultAccess(
    svc,
    user(),
    "outputs",
    "write",
    undefined,
    { keyUnknown: true },
  );
  assertEquals(decision.rule, "vault-deny");
  assertEquals(decision.grantId, deny.id);
  assertEquals(decision.undetermined, undefined);
});

Deno.test("decideRunVaultAccess: with keyUnknown and no key condition the decision is unchanged", () => {
  const svc = service([
    grant({ resource: { kind: "vault", pattern: "roomcontrol" } }),
    grant({
      subject: { kind: "user", name: "other" },
      actions: ["write"],
      resource: { kind: "vault", pattern: "erp" },
      condition: 'key == "x"',
    }),
  ]);
  const options = { keyUnknown: true };
  // Another principal's key condition does not apply to bot.
  const refused = decideRunVaultAccess(
    svc,
    user(),
    "erp",
    "write",
    undefined,
    options,
  );
  assertEquals(refused.rule, "vault-scoped");
  assertEquals(refused.undetermined, undefined);
  assertEquals(
    decideRunVaultAccess(svc, user(), "roomcontrol", "read", undefined, options)
      .allowed,
    true,
  );
  assertEquals(
    decideRunVaultAccess(
      svc,
      user(),
      "_token-secrets",
      "read",
      undefined,
      options,
    )
      .rule,
    "reserved",
  );
});

function tokenRecord(overrides: Partial<ServerToken> = {}): ServerToken {
  return {
    name: "ci",
    state: "active",
    principalId: "user:bot",
    principalEmail: "bot@example.com",
    collectives: [],
    groups: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    vaultName: "_token-secrets",
    secretKey: "server-token-ci",
    ...overrides,
  };
}

const binding = {
  name: "ci",
  createdAt: "2026-01-01T00:00:00.000Z",
  principalId: "user:bot",
};

Deno.test("ServeRunVaultPolicy: a token session re-reads its record at most once per TTL", async () => {
  let reads = 0;
  let now = 1_000;
  const deps: RunVaultPolicyDeps = {
    authMode: "token",
    policySnapshotLoader: {
      decisionService: service([
        grant({ subject: { kind: "idp-group", name: "ci" } }),
      ]),
    },
    readTokenRecord: () => {
      reads++;
      return Promise.resolve(tokenRecord({ groups: ["ci"] }));
    },
    now: () => now,
    tokenTtlMs: 10_000,
  };
  const policy = new ServeRunVaultPolicy(deps, {
    source: "token",
    principal: { kind: "user", id: "bot" },
    tokenBinding: binding,
    idpGroups: [],
    collectives: [],
  });
  // The record's groups decide: the bot is scoped through idp-group:ci.
  assertEquals((await policy.decide("erp", "read")).allowed, false);
  assertEquals((await policy.decide("roomcontrol", "read")).allowed, true);
  assertEquals(reads, 1);
  now += 10_000;
  await policy.decide("roomcontrol", "read");
  assertEquals(reads, 2);
});

Deno.test("ServeRunVaultPolicy: only a server-token session's binding is recorded on the run", () => {
  const deps: RunVaultPolicyDeps = {
    authMode: "token",
    policySnapshotLoader: { decisionService: service([grant({})]) },
  };
  const token = new ServeRunVaultPolicy(deps, {
    source: "token",
    principal: { kind: "user", id: "bot" },
    tokenBinding: binding,
    idpGroups: [],
    collectives: [],
  });
  assertEquals(token.triggeringPrincipal?.tokenBinding, binding);
  // An OAuth session's login token is short-lived and never re-checked, so a
  // resume of its run must not re-check it either.
  const oauth = new ServeRunVaultPolicy(deps, {
    source: "session",
    principal: { kind: "user", id: "alice" },
    tokenBinding: binding,
    idpGroups: ["ops"],
    collectives: [],
  });
  assertEquals(oauth.triggeringPrincipal?.tokenBinding, undefined);
  assertEquals(oauth.triggeringPrincipal?.membership.idpGroups, ["ops"]);
});

Deno.test("ServeRunVaultPolicy: a revoked token fails closed once vault grants exist", async () => {
  const policyFor = (grants: Grant[]) =>
    new ServeRunVaultPolicy({
      authMode: "token",
      policySnapshotLoader: { decisionService: service(grants) },
      readTokenRecord: () => Promise.resolve(tokenRecord({ state: "revoked" })),
    }, {
      source: "token",
      principal: { kind: "user", id: "bot" },
      tokenBinding: binding,
      idpGroups: [],
      collectives: [],
    });
  assertEquals((await policyFor([]).decide("erp", "read")).allowed, true);
  assertEquals(
    (await policyFor([grant({ subject: { kind: "user", name: "x" } })])
      .decide("erp", "read")).allowed,
    false,
  );
});

Deno.test("ServeRunVaultPolicy: decides against the current snapshot on every operation", async () => {
  const loader = { decisionService: service([]) };
  const policy = new ServeRunVaultPolicy({
    authMode: "token",
    policySnapshotLoader: loader,
  }, {
    source: "session",
    principal: { kind: "user", id: "bot" },
    idpGroups: [],
    collectives: [],
  });
  assertEquals((await policy.decide("erp", "read")).allowed, true);
  // A reload that writes a vault deny applies to the run's next read.
  loader.decisionService = service([
    grant({ effect: "deny", resource: { kind: "vault", pattern: "erp" } }),
  ]);
  assertEquals((await policy.decide("erp", "read")).allowed, false);
});

Deno.test("ServeRunVaultPolicy: records the triggering principal and its memberships", () => {
  const policy = new ServeRunVaultPolicy({
    authMode: "token",
    policySnapshotLoader: {
      decisionService: service([], [{
        name: "ops",
        members: [{ kind: "service", id: "scheduler" }],
        createdBy: { kind: "user", id: "admin" },
        createdAt: "2026-01-01T00:00:00Z",
      }]),
    },
  }, {
    source: "service",
    principal: SCHEDULER_PRINCIPAL,
    idpGroups: [],
    collectives: [],
  });
  assertEquals(policy.principal, "service:scheduler");
  assertEquals(policy.triggeringPrincipal, {
    kind: "service",
    id: "scheduler",
    membership: { localGroups: ["ops"], idpGroups: [], collectives: [] },
  });
});

Deno.test("serviceRunVaultScope: a trigger principal is scoped by its local groups", async () => {
  const scope = serviceRunVaultScope({
    authMode: "token",
    policySnapshotLoader: {
      decisionService: service(
        [grant({ subject: { kind: "group", name: "triggers" } })],
        [{
          name: "triggers",
          members: [{ kind: "service", id: "scheduler" }],
          createdBy: { kind: "user", id: "admin" },
          createdAt: "2026-01-01T00:00:00Z",
        }],
      ),
    },
  }, SCHEDULER_PRINCIPAL);
  assert(scope);
  assertEquals((await scope.access.decide("erp", "read")).allowed, false);
  assertEquals(
    (await scope.access.decide("roomcontrol", "read")).allowed,
    true,
  );
});

Deno.test("createRunVaultScope: no scope when authorization is off or no policy is loaded", () => {
  const inputs = {
    source: "session" as const,
    principal: { kind: "user" as const, id: "bot" },
    idpGroups: [],
    collectives: [],
  };
  assertEquals(
    createRunVaultScope({
      authMode: "none",
      policySnapshotLoader: { decisionService: service([grant()]) },
    }, inputs),
    undefined,
  );
  assertEquals(createRunVaultScope({ authMode: "token" }, inputs), undefined);
});

function recorder(): { events: AuditEvent[]; emitter: AuditEmitter } {
  const events: AuditEvent[] = [];
  return {
    events,
    emitter: {
      emit: (event: AuditEvent) => events.push(event),
    } as unknown as AuditEmitter,
  };
}

Deno.test("createRunVaultScope: a refusal is audited once in the secrets category with its run id", async () => {
  const { events, emitter } = recorder();
  const allow = grant();
  const scope = createRunVaultScope({
    authMode: "token",
    policySnapshotLoader: { decisionService: service([allow]) },
    auditEmitter: emitter,
    instanceId: "i-1",
  }, {
    source: "session",
    principal: { kind: "user", id: "bot" },
    idpGroups: ["eng"],
    collectives: [],
  });
  assert(scope);
  scope.runId = "run-1";
  for (let i = 0; i < 2; i++) {
    await assertRejects(
      () =>
        runWithVaultAccess(
          scope.access,
          () => scope.access.check("erp", "read", "k"),
        ),
      VaultAccessDeniedError,
    );
  }
  assertEquals(events.length, 1);
  const [event] = events;
  assertEquals(event.category, "secrets");
  assertEquals(event.outcome, "denied");
  assertEquals(event.resourceKind, "vault");
  assertEquals(event.resourceName, "erp");
  assertEquals(event.principalId, "bot");
  assertEquals(event.decision?.resourceKind, "vault");
  assertEquals(event.decision?.effect, "deny");
  assertEquals(event.decision?.principalGroups, ["eng"]);
  assertStringIncludes(event.detail ?? "", "run=run-1");
});

Deno.test("resumeRunVaultScope: a resume is held to the recorded principal and memberships", async () => {
  const scope = resumeRunVaultScope({
    authMode: "token",
    policySnapshotLoader: {
      decisionService: service([
        grant({ subject: { kind: "idp-group", name: "ci" } }),
      ]),
    },
  }, {
    id: "run-1",
    initiatedBy: "user:bot",
    triggeringPrincipal: {
      kind: "user",
      id: "bot",
      membership: { localGroups: [], idpGroups: ["ci"], collectives: [] },
    },
  });
  assert(scope);
  assertEquals(scope.runId, "run-1");
  assertEquals(scope.access.triggeringPrincipal?.id, "bot");
  assertEquals((await scope.access.decide("erp", "read")).allowed, false);
  assertEquals(
    (await scope.access.decide("roomcontrol", "read")).allowed,
    true,
  );
});

Deno.test("resumeRunVaultScope: a run with no recorded principal fails closed once vault grants exist", async () => {
  const run = { id: "run-1", initiatedBy: "user:bot" };
  const without = resumeRunVaultScope({
    authMode: "token",
    policySnapshotLoader: { decisionService: service([]) },
  }, run);
  assert(without);
  assertEquals((await without.access.decide("erp", "read")).allowed, true);
  assertEquals(without.access.triggeringPrincipal, undefined);
  const withGrants = resumeRunVaultScope({
    authMode: "token",
    policySnapshotLoader: {
      decisionService: service([
        grant({ subject: { kind: "user", name: "someone-else" } }),
      ]),
    },
  }, run);
  assert(withGrants);
  const decision = await withGrants.access.decide("erp", "read");
  assertEquals(decision.allowed, false);
});

Deno.test("resumeRunVaultScope: a resume of a token-triggered run revalidates the token and keeps the recorded memberships", async () => {
  const scopeFor = (record: ServerToken) =>
    resumeRunVaultScope({
      authMode: "token",
      policySnapshotLoader: {
        decisionService: service([
          grant({ subject: { kind: "idp-group", name: "ci" } }),
        ]),
      },
      readTokenRecord: () => Promise.resolve(record),
    }, {
      id: "run-1",
      initiatedBy: "user:bot",
      triggeringPrincipal: {
        kind: "user",
        id: "bot",
        tokenBinding: binding,
        membership: { localGroups: [], idpGroups: ["ci"], collectives: [] },
      },
    });

  // Active: the recorded IdP group decides, not the record's (empty) groups.
  const active = scopeFor(tokenRecord());
  assert(active);
  assertEquals(
    (await active.access.decide("roomcontrol", "read")).allowed,
    true,
  );
  assertEquals((await active.access.decide("erp", "read")).allowed, false);

  // Revoked: every vault operation is refused.
  const revoked = scopeFor(tokenRecord({ state: "revoked" }));
  assert(revoked);
  assertEquals(
    (await revoked.access.decide("roomcontrol", "read")).allowed,
    false,
  );

  // Expired but not yet collected: the run was authorized when it started,
  // so expiry alone does not cut it off.
  const expired = scopeFor(
    tokenRecord({ expiresAt: "2000-01-01T00:00:00.000Z" }),
  );
  assert(expired);
  assertEquals(
    (await expired.access.decide("roomcontrol", "read")).allowed,
    true,
  );
});
