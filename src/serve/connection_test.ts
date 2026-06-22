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
import { handleMessage, validateServerRequest } from "./connection.ts";
import type { ConnectionContext } from "./connection.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import type { Principal } from "../domain/access/principal.ts";
import type { ServeAuthConfig } from "../domain/access/serve_auth_config.ts";
import { PolicySnapshot } from "../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import type { Grant } from "../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";

await initializeLogging({});

// ── Mock WebSocket ──────────────────────────────────────────────────────

interface MockSocket {
  sent: string[];
  closed: boolean;
  readyState: number;
  send(data: string): void;
  close(): void;
}

function createMockSocket(): MockSocket {
  return {
    sent: [],
    closed: false,
    readyState: WebSocket.OPEN,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
    },
  };
}

function parseSent(mock: MockSocket, index = 0): Record<string, unknown> {
  return JSON.parse(mock.sent[index]);
}

// Stub ConnectionContext — handleMessage only needs it for dispatch, and
// workflow/model handlers won't be reached in validation-level tests.
const stubCtx = {} as ConnectionContext;

function makeEvent(data: string): MessageEvent {
  return new MessageEvent("message", { data });
}

// ── validateServerRequest ───────────────────────────────────────────────

Deno.test("validateServerRequest accepts a valid workflow.run request", () => {
  const input = {
    type: "workflow.run",
    id: "req-1",
    payload: { workflowIdOrName: "deploy" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts a valid model.method.run request", () => {
  const input = {
    type: "model.method.run",
    id: "req-2",
    payload: { modelIdOrName: "my-model", methodName: "start" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts a valid cancel request", () => {
  const input = { type: "cancel", id: "req-3" };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest rejects unknown type", () => {
  const input = { type: "unknown.type", id: "req-4" };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest rejects empty id", () => {
  const input = { type: "cancel", id: "" };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest rejects missing payload for workflow.run", () => {
  const input = { type: "workflow.run", id: "req-5" };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest rejects missing methodName for model.method.run", () => {
  const input = {
    type: "model.method.run",
    id: "req-6",
    payload: { modelIdOrName: "m" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

// ── handleMessage: invalid JSON ─────────────────────────────────────────

Deno.test("handleMessage sends error for invalid JSON", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent("not json{{{"),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "invalid_request");
});

// ── handleMessage: validation failure ───────────────────────────────────

Deno.test("handleMessage sends error for invalid request shape", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "bad", id: "x" })),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "invalid_request");
});

// ── handleMessage: cancel ───────────────────────────────────────────────

Deno.test("handleMessage cancel aborts the matching controller", () => {
  const mock = createMockSocket();
  const controller = new AbortController();
  const active = new Map<string, AbortController>([["req-10", controller]]);

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "cancel", id: "req-10" })),
  );

  assertEquals(controller.signal.aborted, true);
  // Cancel does not send a response
  assertEquals(mock.sent.length, 0);
});

Deno.test("handleMessage cancel for unknown id is a no-op", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "cancel", id: "nonexistent" })),
  );

  assertEquals(mock.sent.length, 0);
});

// ── handleMessage: duplicate request ID ─────────────────────────────────

Deno.test("handleMessage rejects duplicate request ID", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>([
    ["dup-1", new AbortController()],
  ]);

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.run",
      id: "dup-1",
      payload: { workflowIdOrName: "w" },
    })),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "duplicate_id");
});

// ── handleMessage: unknown type not leaked ──────────────────────────────

Deno.test("handleMessage does not leak unknown type value in error", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "secret.op", id: "x" })),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  // The error message should NOT contain the actual type value
  const errorMessage = String(
    (msg.error as Record<string, unknown>).message,
  );
  assertEquals(errorMessage.includes("secret.op"), false);
});

// ── validateServerRequest: new access frame types ─────────────────────

Deno.test("validateServerRequest accepts access.grant.list", () => {
  const input = {
    type: "access.grant.list",
    id: "req-1",
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts access.grant.list with payload", () => {
  const input = {
    type: "access.grant.list",
    id: "req-1",
    payload: { subject: "user:adam" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts access.group.list", () => {
  const input = {
    type: "access.group.list",
    id: "req-1",
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts access.check", () => {
  const input = {
    type: "access.check",
    id: "req-1",
    payload: {
      subject: "user:adam",
      action: "run",
      resource: "workflow:@acme/deploy",
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts access.check with collectives", () => {
  const input = {
    type: "access.check",
    id: "req-1",
    payload: {
      subject: "user:adam",
      action: "run",
      resource: "workflow:@acme/deploy",
      collectives: ["platform-eng"],
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts access.reload", () => {
  const input = {
    type: "access.reload",
    id: "req-1",
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts model.method.run with typeArg", () => {
  const input = {
    type: "model.method.run",
    id: "req-1",
    payload: {
      modelIdOrName: "@swamp/grant",
      methodName: "create",
      typeArg: "@swamp/grant",
      definitionName: "grant-abc12345",
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest rejects access.check without payload", () => {
  const input = {
    type: "access.check",
    id: "req-1",
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest accepts access.can-i with action and resource", () => {
  const input = {
    type: "access.can-i",
    id: "req-1",
    payload: {
      action: "run",
      resource: "workflow:@acme/deploy",
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts access.can-i without action/resource for enumeration", () => {
  const input = {
    type: "access.can-i",
    id: "req-1",
    payload: {},
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts access.can-i with collectives", () => {
  const input = {
    type: "access.can-i",
    id: "req-1",
    payload: {
      collectives: ["platform-eng", "ops"],
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest rejects access.can-i without id", () => {
  const input = {
    type: "access.can-i",
    payload: {},
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest rejects access.can-i with action but no resource", () => {
  const input = {
    type: "access.can-i",
    id: "req-1",
    payload: { action: "run" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest rejects access.can-i with resource but no action", () => {
  const input = {
    type: "access.can-i",
    id: "req-1",
    payload: { resource: "workflow:@acme/deploy" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

// ── Authorization test helpers ────────────────────────────────────────────

const modeNoneConfig: ServeAuthConfig = {
  mode: "none",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
};

const modeTokenConfig: ServeAuthConfig = {
  mode: "token",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
};

const testPrincipal: Principal = { kind: "user", id: "adam" };

function makeGrant(
  overrides: Partial<Grant> & {
    subject: Grant["subject"];
    resource: Grant["resource"];
    actions: Grant["actions"];
  },
): Grant {
  return {
    id: overrides.id ?? "grant-1",
    effect: overrides.effect ?? "allow",
    state: overrides.state ?? "active",
    source: overrides.source ?? "method",
    condition: overrides.condition,
    createdBy: overrides.createdBy ?? { kind: "user", id: "admin" },
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeMockSnapshotLoader(
  grants: Grant[],
): PolicySnapshotLoader {
  const snapshot = new PolicySnapshot(grants, []);
  const service = new GrantBasedAccessDecisionService(snapshot);
  return {
    snapshot,
    decisionService: service,
    load: () => Promise.resolve(snapshot),
    loadWithCounts: () =>
      Promise.resolve({ snapshot, grantCount: grants.length, groupCount: 0 }),
    dispose: () => Promise.resolve(),
  } as unknown as PolicySnapshotLoader;
}

const stubRepoContext = {
  definitionRepo: {
    findByNameGlobal: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listTypes: () => Promise.resolve([]),
    listByType: () => Promise.resolve([]),
  },
} as unknown as ConnectionContext["repoContext"];

const stubRepoDir = await Deno.makeTempDir({ prefix: "swamp_conn_test_" });

function makeCtx(
  authConfig: ServeAuthConfig,
  grants: Grant[] = [],
): ConnectionContext {
  const ctx: Partial<ConnectionContext> = {
    authConfig,
    repoContext: stubRepoContext,
    repoDir: stubRepoDir,
  };
  if (authConfig.mode !== "none") {
    (ctx as Record<string, unknown>).policySnapshotLoader =
      makeMockSnapshotLoader(grants);
  }
  return ctx as ConnectionContext;
}

// ── Authorization: mode:none bypass ───────────────────────────────────────

Deno.test("authorizeOrReject: mode:none allows all requests without principal", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeNoneConfig);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.reload",
      id: "auth-1",
    })),
    null,
  );

  // mode:none should not send an error — the request proceeds to the handler
  // (which will fail for other reasons in this stub, but not with "unauthorized")
  for (const sent of mock.sent) {
    const msg = JSON.parse(sent);
    if (msg.type === "error") {
      assertEquals(
        (msg.error as Record<string, unknown>).code !== "unauthorized",
        true,
      );
    }
  }
});

// ── Authorization: null principal rejected in enforcing mode ──────────────

Deno.test("authorizeOrReject: null principal rejected in token mode", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.reload",
      id: "auth-2",
    })),
    null,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "no authenticated principal");
  assertStringIncludes(errorMessage, "admin");
  assertStringIncludes(errorMessage, "access:*");
});

// ── Authorization: authorized request succeeds ────────────────────────────

Deno.test("authorizeOrReject: authorized workflow.run proceeds", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [grant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.run",
      id: "auth-3",
      payload: { workflowIdOrName: "@acme/deploy" },
    })),
    testPrincipal,
  );

  // Should not get an unauthorized error — the request proceeds to the handler
  for (const sent of mock.sent) {
    const msg = JSON.parse(sent);
    if (msg.type === "error") {
      assertEquals(
        (msg.error as Record<string, unknown>).code !== "unauthorized",
        true,
      );
    }
  }
});

// ── Authorization: unauthorized request gets error frame ──────────────────

Deno.test("authorizeOrReject: unauthorized workflow.run returns error frame", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.run",
      id: "auth-4",
      payload: { workflowIdOrName: "@acme/deploy" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "user:adam");
  assertStringIncludes(errorMessage, "run");
  assertStringIncludes(errorMessage, "workflow:@acme/deploy");
});

// ── Authorization: admin boundary ─────────────────────────────────────────

Deno.test("authorizeOrReject: access.reload requires admin on access:*", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["read"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [grant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.reload",
      id: "auth-5",
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "admin");
});

Deno.test("authorizeOrReject: access.reload allowed with admin grant", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [grant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.reload",
      id: "auth-6",
    })),
    testPrincipal,
  );

  // Should not get unauthorized — proceeds to handler (which may fail for other reasons)
  for (const sent of mock.sent) {
    const msg = JSON.parse(sent);
    if (msg.type === "error") {
      assertEquals(
        (msg.error as Record<string, unknown>).code !== "unauthorized",
        true,
      );
    }
  }
});

// ── Authorization: grant list requires read on access:grant ───────────────

Deno.test("authorizeOrReject: access.grant.list rejected without read grant", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.grant.list",
      id: "auth-7",
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "read");
  assertStringIncludes(errorMessage, "access:grant");
});

// ── Authorization: group list requires read on access:group ───────────────

Deno.test("authorizeOrReject: access.group.list rejected without read grant", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.group.list",
      id: "auth-8",
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "read");
  assertStringIncludes(errorMessage, "access:group");
});

// ── Authorization: admin on access:* implies other actions ────────────────

Deno.test("authorizeOrReject: admin on access:* allows grant list without explicit read", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [grant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.grant.list",
      id: "auth-admin-1",
    })),
    testPrincipal,
  );

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(unauthorizedErrors.length, 0);
});

Deno.test("authorizeOrReject: admin on access:* allows group list without explicit read", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [grant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.group.list",
      id: "auth-admin-2",
    })),
    testPrincipal,
  );

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(unauthorizedErrors.length, 0);
});

// ── Authorization: admin superuser fallback & explicit deny ──────────────

Deno.test("authorizeOrReject: admin on access:* grants workflow run (superuser)", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [grant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.run",
      id: "auth-admin-wf",
      payload: { workflowIdOrName: "@acme/deploy" },
    })),
    testPrincipal,
  );

  const messages = mock.sent.map((s) => JSON.parse(s));
  const errorMsg = messages.find((m: Record<string, unknown>) =>
    m.type === "error" &&
    (m.error as Record<string, unknown>).code === "unauthorized"
  );
  assertEquals(errorMsg, undefined, "admin superuser should not be denied");
});

Deno.test("authorizeOrReject: explicit deny beats admin on access:*", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const grants: Grant[] = [
    makeGrant({
      id: "deny-read",
      subject: { kind: "user", name: "adam" },
      effect: "deny",
      actions: ["read"],
      resource: { kind: "access", pattern: "grant" },
    }),
    makeGrant({
      id: "admin-all",
      subject: { kind: "user", name: "adam" },
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    }),
  ];
  const ctx = makeCtx(modeTokenConfig, grants);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.grant.list",
      id: "auth-deny-admin-1",
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "explicitly denied");
});

Deno.test("authorizeOrReject: explicit deny returns denied error frame", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const grants: Grant[] = [
    makeGrant({
      id: "deny-1",
      subject: { kind: "user", name: "adam" },
      effect: "deny",
      actions: ["run"],
      resource: { kind: "workflow", pattern: "*" },
    }),
    makeGrant({
      id: "allow-1",
      subject: { kind: "user", name: "adam" },
      effect: "allow",
      actions: ["run"],
      resource: { kind: "workflow", pattern: "*" },
    }),
  ];
  const ctx = makeCtx(modeTokenConfig, grants);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.run",
      id: "auth-9",
      payload: { workflowIdOrName: "@acme/deploy" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "explicitly denied");
});

// ── Authorization: missing policySnapshotLoader in enforcing mode ─────────

// ── Authorization: denormalized access model typeArgs require admin ──────────
// Regression tests for CVE: canonicalization mismatch between authorization
// gate (raw typeArg) and executor (normalized ModelType). Every separator
// variant that normalizes to an access-control model must require admin.

const lowPrivGrant = makeGrant({
  subject: { kind: "user", name: "adam" },
  actions: ["run"],
  resource: { kind: "model", pattern: "*" },
});

function assertDenormDenied(
  typeArg: string,
  label: string,
): void {
  Deno.test(`isAccessModelType: denormalized ${label} "${typeArg}" requires admin`, async () => {
    const mock = createMockSocket();
    const active = new Map<string, AbortController>();
    const ctx = makeCtx(modeTokenConfig, [lowPrivGrant]);

    handleMessage(
      mock as unknown as WebSocket,
      ctx,
      active,
      makeEvent(JSON.stringify({
        type: "model.method.run",
        id: `denorm-${label}`,
        payload: {
          modelIdOrName: "attack-def",
          methodName: "create",
          typeArg,
          definitionName: "attack-def",
        },
      })),
      testPrincipal,
    );

    // handleModelMethodRun is async — wait for the task to settle
    await new Promise((r) => setTimeout(r, 50));

    assertEquals(mock.sent.length, 1);
    const msg = parseSent(mock);
    assertEquals(msg.type, "error");
    assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
    const errorMessage = String(
      (msg.error as Record<string, unknown>).message,
    );
    assertStringIncludes(errorMessage, "admin");
    assertStringIncludes(errorMessage, "access:*");
  });
}

// grant: dot separator
assertDenormDenied("swamp.grant", "grant-dot");
// grant: double-colon separator
assertDenormDenied("swamp::grant", "grant-doublecolon");
// grant: uppercase
assertDenormDenied("SWAMP/GRANT", "grant-uppercase");
// grant: double-slash
assertDenormDenied("swamp//grant", "grant-doubleslash");
// grant: whitespace separator
assertDenormDenied("swamp grant", "grant-space");
// grant: canonical with @ prefix
assertDenormDenied("@swamp/grant", "grant-at-prefix");
// grant: canonical without @
assertDenormDenied("swamp/grant", "grant-canonical");

// group: dot separator
assertDenormDenied("swamp.group", "group-dot");
// group: double-colon separator
assertDenormDenied("swamp::group", "group-doublecolon");
// group: uppercase
assertDenormDenied("SWAMP/GROUP", "group-uppercase");
// group: whitespace separator
assertDenormDenied("swamp group", "group-space");
// group: canonical
assertDenormDenied("swamp/group", "group-canonical");

// server-token: dot separator (swamp.server-token normalizes to swamp/server-token)
assertDenormDenied("swamp.server-token", "server-token-dot");
// server-token: double-colon separator
assertDenormDenied("swamp::server-token", "server-token-doublecolon");
// server-token: uppercase
assertDenormDenied("SWAMP/SERVER-TOKEN", "server-token-uppercase");
// server-token: canonical
assertDenormDenied("swamp/server-token", "server-token-canonical");

Deno.test("isAccessModelType: normal model typeArg still uses model:* run, not admin", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, [lowPrivGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "normal-model",
      payload: {
        modelIdOrName: "my-shell",
        methodName: "run",
        typeArg: "command/shell",
        definitionName: "my-shell",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  // Should NOT get an unauthorized error — the request proceeds past authz
  for (const sent of mock.sent) {
    const msg = JSON.parse(sent);
    if (msg.type === "error") {
      assertEquals(
        (msg.error as Record<string, unknown>).code !== "unauthorized",
        true,
      );
    }
  }
});

Deno.test("isAccessModelType: admin user can still run canonical swamp/grant", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const adminGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [adminGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "admin-grant",
      payload: {
        modelIdOrName: "grant-def",
        methodName: "create",
        typeArg: "@swamp/grant",
        definitionName: "grant-def",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  // Should not get unauthorized — admin on access:* is sufficient
  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(unauthorizedErrors.length, 0);
});

// ── Authorization: missing policySnapshotLoader in enforcing mode ─────────

Deno.test("authorizeOrReject: missing snapshot loader rejects in token mode", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = {
    authConfig: modeTokenConfig,
  } as ConnectionContext;

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.reload",
      id: "auth-10",
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals(
    (msg.error as Record<string, unknown>).code,
    "access_not_configured",
  );
});

// ── validateServerRequest: new data/model/workflow/vault/report types ────

Deno.test("validateServerRequest accepts data.get", () => {
  const input = {
    type: "data.get",
    id: "req-dg-1",
    payload: { modelIdOrName: "hello", dataName: "result" },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts data.get with optional fields", () => {
  const input = {
    type: "data.get",
    id: "req-dg-2",
    payload: { workflowName: "deploy", runId: "latest", version: 2 },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts data.query", () => {
  const input = {
    type: "data.query",
    id: "req-dq-1",
    payload: { predicate: 'modelType == "command/shell"' },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest rejects data.query without predicate", () => {
  const input = {
    type: "data.query",
    id: "req-dq-2",
    payload: {},
  };
  assertEquals(typeof validateServerRequest(input), "string");
});

Deno.test("validateServerRequest accepts data.list", () => {
  const input = {
    type: "data.list",
    id: "req-dl-1",
    payload: { modelIdOrName: "hello" },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts model.search", () => {
  const input = {
    type: "model.search",
    id: "req-ms-1",
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts model.search with query", () => {
  const input = {
    type: "model.search",
    id: "req-ms-2",
    payload: { query: "hello" },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts model.method.describe", () => {
  const input = {
    type: "model.method.describe",
    id: "req-md-1",
    payload: { modelIdOrName: "hello", methodName: "execute" },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest rejects model.method.describe without methodName", () => {
  const input = {
    type: "model.method.describe",
    id: "req-md-2",
    payload: { modelIdOrName: "hello" },
  };
  assertEquals(typeof validateServerRequest(input), "string");
});

Deno.test("validateServerRequest accepts workflow.search", () => {
  const input = {
    type: "workflow.search",
    id: "req-ws-1",
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts vault.get", () => {
  const input = {
    type: "vault.get",
    id: "req-vg-1",
    payload: { vaultNameOrId: "default" },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest rejects vault.get without vaultNameOrId", () => {
  const input = {
    type: "vault.get",
    id: "req-vg-2",
    payload: {},
  };
  assertEquals(typeof validateServerRequest(input), "string");
});

Deno.test("validateServerRequest accepts vault.put", () => {
  const input = {
    type: "vault.put",
    id: "req-vp-1",
    payload: { vaultName: "default", key: "API_KEY", value: "secret" },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest rejects vault.put without value", () => {
  const input = {
    type: "vault.put",
    id: "req-vp-2",
    payload: { vaultName: "default", key: "API_KEY" },
  };
  assertEquals(typeof validateServerRequest(input), "string");
});

Deno.test("validateServerRequest accepts audit.timeline", () => {
  const input = {
    type: "audit.timeline",
    id: "req-at-1",
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts audit.timeline with options", () => {
  const input = {
    type: "audit.timeline",
    id: "req-at-2",
    payload: { hours: 4, showAll: true },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts summarise", () => {
  const input = {
    type: "summarise",
    id: "req-sum-1",
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts report.get", () => {
  const input = {
    type: "report.get",
    id: "req-rg-1",
    payload: { reportName: "cost-summary" },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest rejects report.get without reportName", () => {
  const input = {
    type: "report.get",
    id: "req-rg-2",
    payload: {},
  };
  assertEquals(typeof validateServerRequest(input), "string");
});

Deno.test("validateServerRequest accepts report.search", () => {
  const input = {
    type: "report.search",
    id: "req-rs-1",
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts report.search with filters", () => {
  const input = {
    type: "report.search",
    id: "req-rs-2",
    payload: { query: "cost", labels: ["summary"] },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts report.describe", () => {
  const input = {
    type: "report.describe",
    id: "req-rd-1",
    payload: { reportName: "cost-summary" },
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

Deno.test("validateServerRequest accepts report.type.search", () => {
  const input = {
    type: "report.type.search",
    id: "req-rts-1",
  };
  assertEquals(typeof validateServerRequest(input), "object");
});

// ── Authorization: new request types ────────────────────────────────────

Deno.test("authorizeOrReject: data.get rejected without read grant", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "data.get",
      id: "auth-dg-1",
      payload: { modelIdOrName: "hello", dataName: "result" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "data:hello",
  );
});

Deno.test("authorizeOrReject: data.query rejected without read grant", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "data.query",
      id: "auth-dq-1",
      payload: { predicate: "size > 0" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "data:*",
  );
});

Deno.test("authorizeOrReject: model.search rejected without read grant", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.search",
      id: "auth-ms-1",
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "model:*",
  );
});

Deno.test("authorizeOrReject: vault.get rejected without read grant", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "vault.get",
      id: "auth-vg-1",
      payload: { vaultNameOrId: "default" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "data:vault",
  );
});

Deno.test("authorizeOrReject: vault.put rejected without write grant", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "vault.put",
      id: "auth-vp-1",
      payload: { vaultName: "default", key: "K", value: "V" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "data:vault",
  );
});

Deno.test("authorizeOrReject: vault.put with refreshFrom requires admin", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const writeGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["write"],
    resource: { kind: "data", pattern: "vault" },
  });
  const ctx = makeCtx(modeTokenConfig, [writeGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "vault.put",
      id: "auth-vp-refresh-1",
      payload: {
        vaultName: "default",
        key: "K",
        value: "V",
        refreshFrom: "curl https://evil.com",
      },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "admin",
  );
});

Deno.test("authorizeOrReject: vault.put with clearRefresh requires admin", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const writeGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["write"],
    resource: { kind: "data", pattern: "vault" },
  });
  const ctx = makeCtx(modeTokenConfig, [writeGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "vault.put",
      id: "auth-vp-clear-1",
      payload: {
        vaultName: "default",
        key: "K",
        value: "V",
        clearRefresh: true,
      },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "admin",
  );
});

Deno.test("authorizeOrReject: vault.put with empty refreshFrom requires admin", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const writeGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["write"],
    resource: { kind: "data", pattern: "vault" },
  });
  const ctx = makeCtx(modeTokenConfig, [writeGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "vault.put",
      id: "auth-vp-empty-refresh",
      payload: {
        vaultName: "default",
        key: "K",
        value: "V",
        refreshFrom: "",
      },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "admin",
  );
});

Deno.test("authorizeOrReject: audit.timeline rejected without read grant", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "audit.timeline",
      id: "auth-at-1",
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "model:*",
  );
});

Deno.test("authorizeOrReject: admin on access:* grants data.get (superuser)", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const grant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [grant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "data.get",
      id: "auth-dg-admin",
      payload: { modelIdOrName: "hello", dataName: "result" },
    })),
    testPrincipal,
  );

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(
    unauthorizedErrors.length,
    0,
    "admin superuser should not be denied data.get",
  );
});
