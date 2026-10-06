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
  type AdminAuthDeps,
  authenticateAdmin,
  authenticateDashboardSessionToken,
  authenticateToken,
  checkDashboardSessionIpBurst,
  createReadAuthorizer,
} from "./admin_auth.ts";
import type {
  AccessDecisionService,
  AccessResource,
  PolicySnapshotLoader,
} from "../domain/access/mod.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DashboardSession } from "./dashboard_session_store.ts";

const DASHBOARD_SESSION: DashboardSession = {
  id: "a".repeat(64),
  tokenName: "dashboard-token",
  tokenCreatedAt: "2026-10-06T00:00:00.000Z",
  origin: "https://serve.test",
  createdAt: "2026-10-06T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function dashboardTokenRepoContext(
  state: "active" | "revoked" = "active",
): RepositoryContext {
  const token = {
    name: DASHBOARD_SESSION.tokenName,
    state,
    principalId: "user:operator",
    principalEmail: "operator@test",
    collectives: ["team-a"],
    groups: ["ops"],
    createdAt: DASHBOARD_SESSION.tokenCreatedAt,
    expiresAt: "2099-01-01T00:00:00.000Z",
    vaultName: "tokens",
    secretKey: "dashboard-token",
  };
  const content = new TextEncoder().encode(JSON.stringify(token));
  return {
    definitionRepo: {
      findByName: () => Promise.resolve({ id: "dashboard-token-id" }),
    },
    unifiedDataRepo: {
      getContent: () => Promise.resolve(content),
    },
  } as unknown as RepositoryContext;
}

function makeDeps(overrides: Partial<AdminAuthDeps> = {}): AdminAuthDeps {
  return {
    authMode: "token",
    repoDir: "/tmp/test",
    // deno-lint-ignore no-explicit-any
    repoContext: {} as any,
    policySnapshotLoader: null,
    trustProxy: false,
    ...overrides,
  };
}

/**
 * A client address unique to this run. The rate limiter is module state that
 * keys a malformed token by client address, so tests sharing one address
 * exhaust it across `deno test --repeats`.
 */
function freshClientAddr(): string {
  return `client-${crypto.randomUUID()}`;
}

Deno.test("authenticateAdmin: no-auth mode returns anonymous principal", async () => {
  const deps = makeDeps({ authMode: "none" });
  const req = new Request("http://localhost/api/v1/health");
  const result = await authenticateAdmin(req, "127.0.0.1", deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.authResult.principalId, "@anonymous");
  }
});

Deno.test("authenticateAdmin: returns 401 with missing bearer prefix", async () => {
  const deps = makeDeps();
  const req = new Request("http://localhost/api/v1/health", {
    headers: { authorization: "Token test.token" },
  });
  const result = await authenticateAdmin(req, "127.0.0.1", deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 401);
  }
});

Deno.test("authenticateAdmin: returns 401 without bearer token", async () => {
  const deps = makeDeps();
  const req = new Request("http://localhost/api/v1/health");
  const result = await authenticateAdmin(req, "127.0.0.1", deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 401);
  }
});

Deno.test("authenticateAdmin: returns 401 with invalid token", async () => {
  const deps = makeDeps();
  const req = new Request("http://localhost/api/v1/health", {
    headers: { authorization: "Bearer not-a-valid-token" },
  });
  const result = await authenticateAdmin(req, freshClientAddr(), deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 401);
  }
});

Deno.test("authenticateAdmin: trustProxy passes x-forwarded-for through auth flow", async () => {
  const deps = makeDeps({ trustProxy: true });
  const req = new Request("http://localhost/api/v1/health", {
    headers: {
      authorization: "Bearer not-a-valid-token",
      "x-forwarded-for": `${freshClientAddr()}, 192.168.1.1`,
    },
  });
  const result = await authenticateAdmin(req, "127.0.0.1", deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 401);
  }
});

Deno.test("authenticateToken: no-auth mode is anonymous with no token binding", async () => {
  const deps = makeDeps({ authMode: "none" });
  const req = new Request("http://localhost/api/v1/health/stream");
  const result = await authenticateToken(req, "127.0.0.1", deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.authResult.principalId, "@anonymous");
    assertEquals(result.token, null);
    assertEquals(result.clientAddr, "127.0.0.1");
  }
});

Deno.test("authenticateToken: trustProxy reports the forwarded client address", async () => {
  const deps = makeDeps({ authMode: "none", trustProxy: true });
  const req = new Request("http://localhost/api/v1/health/stream", {
    headers: { "x-forwarded-for": "10.0.0.9, 192.168.1.1" },
  });
  const result = await authenticateToken(req, "127.0.0.1", deps);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.clientAddr, "10.0.0.9");
});

Deno.test("authenticateToken: returns 401 without a bearer token", async () => {
  const deps = makeDeps();
  const req = new Request("http://localhost/api/v1/health/stream");
  const result = await authenticateToken(req, "127.0.0.1", deps);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.response.status, 401);
});

Deno.test("authenticateToken: does not treat a dashboard session cookie as an admin credential", async () => {
  const deps = makeDeps();
  const req = new Request("http://localhost/api/v1/cancel", {
    headers: { cookie: "swamp-dashboard-session=opaque-session-id" },
  });
  const result = await authenticateToken(req, "127.0.0.1", deps);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.response.status, 401);
});

Deno.test("authenticateDashboardSessionToken: returns the token mint binding for a valid session", async () => {
  const result = await authenticateDashboardSessionToken(
    new Request("https://serve.test/api/v1/health"),
    freshClientAddr(),
    makeDeps({ repoContext: dashboardTokenRepoContext() }),
    DASHBOARD_SESSION,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.authResult.principalId, "user:operator");
    assertEquals(result.token, {
      name: "dashboard-token",
      createdAt: "2026-10-06T00:00:00.000Z",
    });
  }
});

Deno.test("authenticateDashboardSessionToken: marks revoked backing tokens for session invalidation", async () => {
  const result = await authenticateDashboardSessionToken(
    new Request("https://serve.test/api/v1/health"),
    freshClientAddr(),
    makeDeps({ repoContext: dashboardTokenRepoContext("revoked") }),
    DASHBOARD_SESSION,
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 401);
    assertEquals(result.invalidateSession, true);
  }
});

Deno.test("checkDashboardSessionIpBurst: limits unknown dashboard cookie probes before session lookup", () => {
  const request = new Request("https://serve.test/api/v1/health", {
    headers: { cookie: `swamp-dashboard-session=${"a".repeat(64)}` },
  });
  const clientAddr = freshClientAddr();
  for (let attempt = 0; attempt < 50; attempt++) {
    assertEquals(
      checkDashboardSessionIpBurst(request, clientAddr, makeDeps()).ok,
      true,
    );
  }

  const limited = checkDashboardSessionIpBurst(
    request,
    clientAddr,
    makeDeps(),
  );
  assertEquals(limited.ok, false);
  if (!limited.ok) assertEquals(limited.response.status, 429);
});

Deno.test("authenticateToken: returns 401 with an invalid token", async () => {
  const deps = makeDeps();
  const req = new Request("http://localhost/api/v1/health/stream", {
    headers: { authorization: `Bearer not-${crypto.randomUUID()}` },
  });
  const result = await authenticateToken(req, freshClientAddr(), deps);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.response.status, 401);
});

const PRINCIPAL = {
  ok: true as const,
  principalId: "user:operator",
  collectives: ["team-a"],
  groups: ["ops"],
};

/** A policy answering from `rules`, keyed by "action kind:name". */
function policy(
  rules: Record<string, "allow" | "deny">,
): PolicySnapshotLoader {
  const service = {
    decide: (_p: unknown, action: string, resource: AccessResource) => {
      const effect = rules[`${action} ${resource.kind}:${resource.name}`];
      return effect
        ? {
          effect,
          grantId: "g",
          subject: { kind: "user" as const, name: "operator" },
        }
        : null;
    },
    explain: () => [],
    hasAnyGrantForKind: () => true,
  } as unknown as AccessDecisionService;
  return { decisionService: service } as unknown as PolicySnapshotLoader;
}

const WORKFLOW = (name: string): AccessResource => ({
  kind: "workflow",
  name,
  fields: { name },
});

Deno.test("createReadAuthorizer: auth mode none reads everything as admin", () => {
  const reader = createReadAuthorizer(PRINCIPAL, {
    authMode: "none",
    policySnapshotLoader: null,
  });
  assertEquals(reader.isAdmin(), true);
  assertEquals(reader.canRead(WORKFLOW("any")), true);
});

Deno.test("createReadAuthorizer: without a policy snapshot nothing is readable", () => {
  const reader = createReadAuthorizer(PRINCIPAL, {
    authMode: "token",
    policySnapshotLoader: null,
  });
  assertEquals(reader.isAdmin(), false);
  assertEquals(reader.canRead(WORKFLOW("any")), false);
});

Deno.test("createReadAuthorizer: explicit allow and deny win; uncovered resources need admin", () => {
  const rules = {
    "read workflow:open": "allow",
    "read workflow:closed": "deny",
  } as const;
  const operator = createReadAuthorizer(PRINCIPAL, {
    authMode: "token",
    policySnapshotLoader: policy(rules),
  });
  assertEquals(operator.isAdmin(), false);
  assertEquals(operator.canRead(WORKFLOW("open")), true);
  assertEquals(operator.canRead(WORKFLOW("closed")), false);
  assertEquals(operator.canRead(WORKFLOW("uncovered")), false);

  const admin = createReadAuthorizer(PRINCIPAL, {
    authMode: "token",
    policySnapshotLoader: policy({ ...rules, "admin access:*": "allow" }),
  });
  assertEquals(admin.isAdmin(), true);
  assertEquals(admin.canRead(WORKFLOW("uncovered")), true);
  assertEquals(admin.canRead(WORKFLOW("closed")), false);
});
