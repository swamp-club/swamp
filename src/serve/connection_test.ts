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
import {
  extractRequestId,
  handleMessage,
  sanitizeErrorForClient,
  validateServerRequest,
} from "./connection.ts";
import type { ConnectionContext } from "./connection.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { UserError } from "../domain/errors.ts";
import type { Principal } from "../domain/access/principal.ts";
import type { ServeAuthConfig } from "../domain/access/serve_auth_config.ts";
import { PolicySnapshot } from "../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import type { Grant } from "../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";
import { waitFor } from "@swamp-club/swamp-testing";

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

// ── extractRequestId ────────────────────────────────────────────────────

Deno.test("extractRequestId: returns id when present", () => {
  assertEquals(extractRequestId({ type: "foo", id: "req-1" }), "req-1");
});

Deno.test("extractRequestId: returns 'unknown' when id is missing", () => {
  assertEquals(extractRequestId({ type: "foo" }), "unknown");
});

Deno.test("extractRequestId: returns 'unknown' for non-string id", () => {
  assertEquals(extractRequestId({ type: "foo", id: 123 }), "unknown");
});

Deno.test("extractRequestId: returns 'unknown' for null data", () => {
  assertEquals(extractRequestId(null), "unknown");
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
  assertEquals(msg.id, "x");
  assertEquals((msg.error as Record<string, unknown>).code, "invalid_request");
});

Deno.test("handleMessage echoes request id on validation failure", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "bad", id: "req-42" })),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals(msg.id, "req-42");
});

Deno.test("handleMessage uses 'unknown' id when id is missing", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "bad" })),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals(msg.id, "unknown");
});

Deno.test("handleMessage echoes id for valid type with invalid payload", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.trigger.set",
      id: "client-uuid-123",
      payload: { workflowName: "", schedule: "" },
    })),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals(msg.id, "client-uuid-123");
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
  restrictedModelTypes: [],
  restrictedCommands: [],
};

const modeTokenConfig: ServeAuthConfig = {
  mode: "token",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
  restrictedModelTypes: [],
  restrictedCommands: [],
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
  workflowRepo: {
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
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

Deno.test("authorizeOrReject: unauthorized workflow.run returns error frame", async () => {
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

  await waitFor(() => mock.sent.length >= 1, "unauthorized error frame sent");
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

Deno.test("authorizeOrReject: explicit deny returns denied error frame", async () => {
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

  await waitFor(() => mock.sent.length >= 1, "deny error frame sent");
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "explicitly denied");
});

Deno.test("authorizeOrReject: resolvedUserNames replaces raw ID in error message", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const opaqueId = "699e486007f77116ebf44bd2";
  const principal: Principal = { kind: "user", id: opaqueId };
  const ctx = makeCtx(modeTokenConfig, []);
  ctx.resolvedUserNames = { [opaqueId]: "stack72" };

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.run",
      id: "auth-resolve-1",
      payload: { workflowIdOrName: "@acme/deploy" },
    })),
    principal,
  );

  await waitFor(() => mock.sent.length >= 1, "resolved-name error frame sent");
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "user:stack72");
  assertEquals(errorMessage.includes(opaqueId), false);
});

Deno.test("authorizeOrReject: falls back to raw ID when resolvedUserNames absent", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const opaqueId = "699e486007f77116ebf44bd2";
  const principal: Principal = { kind: "user", id: opaqueId };
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.run",
      id: "auth-resolve-2",
      payload: { workflowIdOrName: "@acme/deploy" },
    })),
    principal,
  );

  await waitFor(() => mock.sent.length >= 1, "raw-id error frame sent");
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, `user:${opaqueId}`);
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

// ── restrictedModelTypes: admin-only enforcement via config ───────────────

const restrictedConfig: ServeAuthConfig = {
  mode: "token",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
  restrictedModelTypes: ["command/shell"],
  restrictedCommands: [],
};

Deno.test("restrictedModelTypes: non-admin denied run on restricted type", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(restrictedConfig, [lowPrivGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "restricted-1",
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

Deno.test("restrictedModelTypes: denormalized restricted type requires admin", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(restrictedConfig, [lowPrivGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "restricted-denorm",
      payload: {
        modelIdOrName: "my-shell",
        methodName: "run",
        typeArg: "Command::Shell",
        definitionName: "my-shell",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
});

Deno.test("restrictedModelTypes: admin can run restricted type", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const adminGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(restrictedConfig, [adminGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "restricted-admin",
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

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(unauthorizedErrors.length, 0);
});

Deno.test("restrictedModelTypes: non-restricted type still allowed for non-admin", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(restrictedConfig, [lowPrivGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "non-restricted",
      payload: {
        modelIdOrName: "my-terraform",
        methodName: "apply",
        typeArg: "terraform/aws",
        definitionName: "my-terraform",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(unauthorizedErrors.length, 0);
});

// ── restrictedCommands: admin-only enforcement via config ─────────────────

const restrictedCommandConfig: ServeAuthConfig = {
  mode: "token",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
  restrictedModelTypes: [],
  restrictedCommands: ["model.search"],
};

Deno.test("restrictedCommands: non-admin denied on restricted command", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(restrictedCommandConfig, [lowPrivGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.search",
      id: "rc-denied-1",
      payload: { query: "test" },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String(
    (msg.error as Record<string, unknown>).message,
  );
  assertStringIncludes(errorMessage, "admin");
  assertStringIncludes(errorMessage, "access:");
  assertStringIncludes(errorMessage, "model.search");
});

Deno.test("restrictedCommands: admin can use restricted command", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const adminGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(restrictedCommandConfig, [adminGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.search",
      id: "rc-admin-1",
      payload: { query: "test" },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(unauthorizedErrors.length, 0);
});

Deno.test("restrictedCommands: non-restricted command still allowed for non-admin", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(restrictedCommandConfig, [lowPrivGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "rc-allowed-1",
      payload: {
        modelIdOrName: "my-model",
        methodName: "run",
        typeArg: "terraform/aws",
        definitionName: "my-model",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

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

Deno.test("authorizeOrReject: data.get rejected without read grant", async () => {
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

  await waitFor(
    () => mock.sent.length >= 1,
    "data.get unauthorized frame sent",
  );
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

Deno.test("authorizeOrReject: admin on access:* grants data.get (superuser)", async () => {
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

  await waitFor(
    () => mock.sent.length >= 1,
    "data.get superuser response sent",
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

// ── Authorization: typeArg execution-target mismatch (SWAMP-003) ────────────
// Regression tests: authorization must check the execution target (typeArg),
// not just the claimed model (modelIdOrName).

const narrowModelGrant = makeGrant({
  subject: { kind: "user", name: "adam" },
  actions: ["run"],
  resource: { kind: "model", pattern: "@acme/my-model" },
});

Deno.test("typeArg authz: narrow grant + mismatched typeArg is denied", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, [narrowModelGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "swamp003-mismatch",
      payload: {
        modelIdOrName: "@acme/my-model",
        methodName: "run",
        typeArg: "command/shell",
        definitionName: "attack-shell",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  const errorMessage = String((msg.error as Record<string, unknown>).message);
  assertStringIncludes(errorMessage, "run");
  assertStringIncludes(errorMessage, "model:command/shell");
});

Deno.test("typeArg authz: direct command/shell without grant is denied", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, [narrowModelGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "swamp003-direct",
      payload: {
        modelIdOrName: "command/shell",
        methodName: "run",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
});

Deno.test("typeArg authz: model:* grant + typeArg still works (no regression)", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, [lowPrivGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "swamp003-wildcard",
      payload: {
        modelIdOrName: "@acme/my-model",
        methodName: "run",
        typeArg: "command/shell",
        definitionName: "my-shell",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(
    unauthorizedErrors.length,
    0,
    "model:* grant should authorize any typeArg",
  );
});

Deno.test("typeArg authz: matching modelIdOrName and typeArg with narrow grant works", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const matchingGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["run"],
    resource: { kind: "model", pattern: "command/shell" },
  });
  const ctx = makeCtx(modeTokenConfig, [narrowModelGrant, matchingGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "swamp003-matching",
      payload: {
        modelIdOrName: "@acme/my-model",
        methodName: "run",
        typeArg: "command/shell",
        definitionName: "my-shell",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(
    unauthorizedErrors.length,
    0,
    "user with grants for both modelIdOrName and typeArg should be authorized",
  );
});

Deno.test("typeArg authz: admin superuser bypasses typeArg check", async () => {
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
      id: "swamp003-admin",
      payload: {
        modelIdOrName: "@acme/my-model",
        methodName: "run",
        typeArg: "command/shell",
        definitionName: "my-shell",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(
    unauthorizedErrors.length,
    0,
    "admin superuser should bypass typeArg authorization",
  );
});

Deno.test("typeArg authz: prefix wildcard grant covers matching typeArg", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const prefixGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["run"],
    resource: { kind: "model", pattern: "command/*" },
  });
  const ctx = makeCtx(modeTokenConfig, [narrowModelGrant, prefixGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "swamp003-prefix",
      payload: {
        modelIdOrName: "@acme/my-model",
        methodName: "run",
        typeArg: "command/shell",
        definitionName: "my-shell",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(
    unauthorizedErrors.length,
    0,
    "prefix wildcard grant command/* should cover command/shell typeArg",
  );
});

Deno.test("typeArg authz: @ prefix on typeArg is stripped before authorization", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const shellGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["run"],
    resource: { kind: "model", pattern: "command/shell" },
  });
  const ctx = makeCtx(modeTokenConfig, [narrowModelGrant, shellGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.method.run",
      id: "swamp003-at-prefix",
      payload: {
        modelIdOrName: "@acme/my-model",
        methodName: "run",
        typeArg: "@command/shell",
        definitionName: "my-shell",
      },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(
    unauthorizedErrors.length,
    0,
    "@ prefix on typeArg should be stripped — grant for command/shell should match @command/shell",
  );
});

// ── handleRunAttach cross-instance fallback tests ───────────────────────

function createMockControlPlaneStore():
  & import("../domain/datastore/control_plane_store.ts").ControlPlaneStore
  & {
    data: Map<string, Uint8Array>;
  } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    put(key: string, value: Uint8Array): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
    },
    get(key: string): Promise<Uint8Array | null> {
      return Promise.resolve(data.get(key) ?? null);
    },
    delete(key: string): Promise<void> {
      data.delete(key);
      return Promise.resolve();
    },
    list(prefix: string): Promise<string[]> {
      return Promise.resolve(
        [...data.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
  };
}

const encoder = new TextEncoder();

function seedActiveRun(
  store: ReturnType<typeof createMockControlPlaneStore>,
  instanceId: string,
  runId: string,
  opts: { resourceName: string; runKind: string },
): void {
  store.data.set(
    `active-runs/${instanceId}/${runId}`,
    encoder.encode(JSON.stringify({
      instanceId,
      resourceName: opts.resourceName,
      runKind: opts.runKind,
      startedAt: "2026-08-01T12:00:00Z",
    })),
  );
}

function seedHeartbeat(
  store: ReturnType<typeof createMockControlPlaneStore>,
  instanceId: string,
  heartbeatAt: string,
): void {
  store.data.set(
    `heartbeats/${instanceId}`,
    encoder.encode(JSON.stringify({
      instanceId,
      hostname: "host-1",
      pid: 1234,
      startedAt: "2026-08-01T11:00:00Z",
      heartbeatAt,
    })),
  );
}

const runAttachGrant = makeGrant({
  subject: { kind: "user", name: "adam" },
  actions: ["run"],
  resource: { kind: "workflow", pattern: "*" },
});

Deno.test("handleRunAttach: miss + active-runs record + fresh heartbeat returns run.elsewhere", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const cpStore = createMockControlPlaneStore();
  seedActiveRun(cpStore, "instance-remote", "run-xyz", {
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
  });
  seedHeartbeat(cpStore, "instance-remote", new Date().toISOString());

  const ctx = makeCtx(modeTokenConfig, [runAttachGrant]);
  (ctx as unknown as Record<string, unknown>).controlPlaneStore = cpStore;

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "run.attach",
      id: "attach-1",
      payload: { runId: "run-xyz" },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const response = parseSent(mock);
  assertEquals(response.type, "run.elsewhere");
  assertEquals(response.id, "attach-1");
  assertEquals(
    (response.payload as Record<string, unknown>).runId,
    "run-xyz",
  );
  assertEquals(
    (response.payload as Record<string, unknown>).instanceId,
    "instance-remote",
  );
});

Deno.test("handleRunAttach: miss + active-runs record + stale heartbeat returns run.interrupted", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const cpStore = createMockControlPlaneStore();
  seedActiveRun(cpStore, "instance-dead", "run-abc", {
    resourceName: "build-model",
    runKind: "workflow-run",
  });
  seedHeartbeat(cpStore, "instance-dead", "2026-07-01T00:00:00Z");

  const ctx = makeCtx(modeTokenConfig, [runAttachGrant]);
  (ctx as unknown as Record<string, unknown>).controlPlaneStore = cpStore;

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "run.attach",
      id: "attach-2",
      payload: { runId: "run-abc" },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const response = parseSent(mock);
  assertEquals(response.type, "run.interrupted");
  assertEquals(response.id, "attach-2");
  assertEquals(
    (response.payload as Record<string, unknown>).reason,
    "instance_dead",
  );
});

Deno.test("handleRunAttach: miss + no active-runs record returns not_found", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const cpStore = createMockControlPlaneStore();

  const ctx = makeCtx(modeTokenConfig, [runAttachGrant]);
  (ctx as unknown as Record<string, unknown>).controlPlaneStore = cpStore;

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "run.attach",
      id: "attach-3",
      payload: { runId: "run-nonexistent" },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const response = parseSent(mock);
  assertEquals(response.type, "error");
  assertEquals(
    (response.error as Record<string, unknown>).code,
    "not_found",
  );
});

Deno.test("handleRunAttach: miss + active-runs record + no heartbeat returns run.interrupted", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const cpStore = createMockControlPlaneStore();
  seedActiveRun(cpStore, "instance-orphaned", "run-orphan", {
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
  });

  const ctx = makeCtx(modeTokenConfig, [runAttachGrant]);
  (ctx as unknown as Record<string, unknown>).controlPlaneStore = cpStore;

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "run.attach",
      id: "attach-4",
      payload: { runId: "run-orphan" },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const response = parseSent(mock);
  assertEquals(response.type, "run.interrupted");
  assertEquals(
    (response.payload as Record<string, unknown>).reason,
    "instance_dead",
  );
});

Deno.test("handleRunAttach: miss + no control-plane store returns not_found", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, [runAttachGrant]);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "run.attach",
      id: "attach-5",
      payload: { runId: "run-anywhere" },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const response = parseSent(mock);
  assertEquals(response.type, "error");
  assertEquals(
    (response.error as Record<string, unknown>).code,
    "not_found",
  );
});

Deno.test("handleRunAttach: miss + active-runs record + unauthorized principal returns error without leaking existence", async () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const cpStore = createMockControlPlaneStore();
  seedActiveRun(cpStore, "instance-remote", "run-secret", {
    resourceName: "secret-workflow",
    runKind: "workflow-run",
  });
  seedHeartbeat(cpStore, "instance-remote", new Date().toISOString());

  const noRunGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [noRunGrant]);
  (ctx as unknown as Record<string, unknown>).controlPlaneStore = cpStore;

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "run.attach",
      id: "attach-6",
      payload: { runId: "run-secret" },
    })),
    testPrincipal,
  );

  await new Promise((r) => setTimeout(r, 50));

  const response = parseSent(mock);
  assertEquals(response.type, "error");
  assertEquals(
    (response.error as Record<string, unknown>).code,
    "unauthorized",
  );
  const allTypes = mock.sent.map((s) => JSON.parse(s).type);
  assertEquals(allTypes.includes("run.elsewhere"), false);
  assertEquals(allTypes.includes("run.interrupted"), false);
});

// ── sanitizeErrorForClient tests ────────────────────────────────────────

Deno.test("sanitizeErrorForClient: redacts absolute Unix paths", () => {
  const result = sanitizeErrorForClient(
    new Error("File not found: /opt/swamp/.swamp/data/foo"),
  );
  assertEquals(result, "An internal error occurred");
});

Deno.test("sanitizeErrorForClient: redacts .swamp internal paths", () => {
  const result = sanitizeErrorForClient(
    new Error("Config at /some/dir/.swamp/config.yaml is invalid"),
  );
  assertEquals(result, "An internal error occurred");
});

Deno.test("sanitizeErrorForClient: redacts Windows drive paths", () => {
  const result = sanitizeErrorForClient(
    new Error("File not found: C:\\Users\\data\\foo"),
  );
  assertEquals(result, "An internal error occurred");
});

Deno.test("sanitizeErrorForClient: redacts /home/ paths", () => {
  const result = sanitizeErrorForClient(
    new Error("Cannot read /home/user/.swamp/secrets/key"),
  );
  assertEquals(result, "An internal error occurred");
});

Deno.test("sanitizeErrorForClient: passes model type slashes (not absolute paths)", () => {
  const result = sanitizeErrorForClient(
    new Error("Model 'acme/invoices' not found"),
  );
  assertEquals(result, "Model 'acme/invoices' not found");
});

Deno.test("sanitizeErrorForClient: passes relative paths in user-facing errors", () => {
  const result = sanitizeErrorForClient(
    new Error('Extension file not found: "data/config.json"'),
  );
  assertEquals(result, 'Extension file not found: "data/config.json"');
});

Deno.test("sanitizeErrorForClient: truncates long messages at 200 chars", () => {
  const longMessage = "x".repeat(300);
  const result = sanitizeErrorForClient(new Error(longMessage));
  assertEquals(result.length, 203); // 200 + "..."
  assertEquals(result.endsWith("..."), true);
});

Deno.test("sanitizeErrorForClient: passes through short non-path errors", () => {
  const result = sanitizeErrorForClient(new Error("Model not found"));
  assertEquals(result, "Model not found");
});

Deno.test("sanitizeErrorForClient: redacts UserError with absolute paths", () => {
  const result = sanitizeErrorForClient(
    new UserError("Config at /etc/swamp/config.yaml is invalid"),
  );
  assertEquals(result, "An internal error occurred");
});

Deno.test("sanitizeErrorForClient: passes safe UserError messages", () => {
  const result = sanitizeErrorForClient(
    new UserError("Invalid token format: expected <name>.<secret>"),
  );
  assertEquals(result, "Invalid token format: expected <name>.<secret>");
});

Deno.test("sanitizeErrorForClient: passes UserError with model type slashes", () => {
  const result = sanitizeErrorForClient(
    new UserError('Paths must not start with "/"'),
  );
  assertEquals(result, 'Paths must not start with "/"');
});

Deno.test("sanitizeErrorForClient: handles non-Error values", () => {
  assertEquals(sanitizeErrorForClient("simple string"), "simple string");
  assertEquals(sanitizeErrorForClient(42), "42");
});

// ── data.query validation tests ─────────────────────────────────────────

Deno.test("validateServerRequest: data.query rejects predicate over 4096 chars", () => {
  const input = {
    type: "data.query",
    id: "req-1",
    payload: { predicate: "a".repeat(5000) },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
  assertStringIncludes(result as string, "predicate");
});

Deno.test("validateServerRequest: data.query rejects limit over 10000", () => {
  const input = {
    type: "data.query",
    id: "req-1",
    payload: { predicate: 'modelType == "test"', limit: 50000 },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest: data.query rejects non-integer limit", () => {
  const input = {
    type: "data.query",
    id: "req-1",
    payload: { predicate: 'modelType == "test"', limit: 1.5 },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest: data.query rejects negative limit", () => {
  const input = {
    type: "data.query",
    id: "req-1",
    payload: { predicate: 'modelType == "test"', limit: -1 },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest: data.query accepts valid predicate and limit", () => {
  const input = {
    type: "data.query",
    id: "req-1",
    payload: { predicate: 'modelType == "test"', limit: 100 },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest: rejects request ID over 256 chars", () => {
  const input = {
    type: "data.query",
    id: "x".repeat(300),
    payload: { predicate: 'modelType == "test"' },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
  assertStringIncludes(result as string, "id");
});

// ── Report/check filter fields on run payloads ──────────────────────────

Deno.test("validateServerRequest: model.method.run accepts report filter fields", () => {
  const input = {
    type: "model.method.run",
    id: "req-filter-1",
    payload: {
      modelIdOrName: "test-model",
      methodName: "run",
      skipAllReports: true,
      skipReportNames: ["summary"],
      skipReportLabels: ["verbose"],
      reportNames: ["compact"],
      reportLabels: ["required"],
      skipAllChecks: true,
      skipCheckNames: ["schema-check"],
      skipCheckLabels: ["optional"],
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest: model.method.run accepts request without filter fields", () => {
  const input = {
    type: "model.method.run",
    id: "req-no-filter",
    payload: {
      modelIdOrName: "test-model",
      methodName: "run",
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest: model.method.run rejects non-boolean skipAllReports", () => {
  const input = {
    type: "model.method.run",
    id: "req-bad-type",
    payload: {
      modelIdOrName: "test-model",
      methodName: "run",
      skipAllReports: "yes",
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest: model.method.run rejects non-array skipReportNames", () => {
  const input = {
    type: "model.method.run",
    id: "req-bad-array",
    payload: {
      modelIdOrName: "test-model",
      methodName: "run",
      skipReportNames: "summary",
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest: workflow.run accepts report filter fields", () => {
  const input = {
    type: "workflow.run",
    id: "req-wf-filter",
    payload: {
      workflowIdOrName: "deploy",
      skipAllReports: true,
      skipReportNames: ["summary"],
      skipReportLabels: ["verbose"],
      reportNames: ["compact"],
      reportLabels: ["required"],
      skipAllChecks: true,
      skipCheckNames: ["schema-check"],
      skipCheckLabels: ["optional"],
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest: workflow.run accepts request without filter fields", () => {
  const input = {
    type: "workflow.run",
    id: "req-wf-no-filter",
    payload: {
      workflowIdOrName: "deploy",
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest: workflow.run rejects non-boolean skipAllChecks", () => {
  const input = {
    type: "workflow.run",
    id: "req-wf-bad-type",
    payload: {
      workflowIdOrName: "deploy",
      skipAllChecks: 1,
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

// ── workflow.schema empty payload fix ───────────────────────────────────

Deno.test("validateServerRequest: workflow.schema accepts empty payload", () => {
  const input = {
    type: "workflow.schema",
    id: "req-schema-empty",
    payload: {},
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest: workflow.schema accepts payload with workflowIdOrName", () => {
  const input = {
    type: "workflow.schema",
    id: "req-schema-named",
    payload: { workflowIdOrName: "deploy" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest: workflow.resume accepts traceparent and tracestate", () => {
  const input = {
    type: "workflow.resume",
    id: "req-resume-trace",
    payload: {
      workflowIdOrName: "deploy",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "congo=t61rcWkgMzE",
    },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest: workflow.resume accepts request without trace fields", () => {
  const input = {
    type: "workflow.resume",
    id: "req-resume-no-trace",
    payload: { workflowIdOrName: "deploy" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

// ── validateServerRequest: new command types (issue #1531) ─────────────

Deno.test("validateServerRequest accepts access.token.list", () => {
  assertEquals(
    typeof validateServerRequest({ type: "access.token.list", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts access.token.revoke", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "access.token.revoke",
      id: "r1",
      payload: { name: "my-token" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest rejects access.token.revoke without name", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "access.token.revoke",
      id: "r1",
      payload: {},
    }),
    "string",
  );
});

Deno.test("validateServerRequest accepts access.token.rotate", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "access.token.rotate",
      id: "r1",
      payload: { name: "my-token", durationMs: 3600000 },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts access.token.rotate without optional fields", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "access.token.rotate",
      id: "r1",
      payload: { name: "my-token" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts model.edit", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "model.edit",
      id: "r1",
      payload: { modelIdOrName: "test-model", content: "name: test" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest rejects model.edit without modelIdOrName", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "model.edit",
      id: "r1",
      payload: {},
    }),
    "string",
  );
});

Deno.test("validateServerRequest accepts model.type.describe", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "model.type.describe",
      id: "r1",
      payload: { typeArg: "command/shell" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest rejects model.type.describe without typeArg", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "model.type.describe",
      id: "r1",
      payload: {},
    }),
    "string",
  );
});

Deno.test("validateServerRequest accepts model.type.search", () => {
  assertEquals(
    typeof validateServerRequest({ type: "model.type.search", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts model.type.search with query", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "model.type.search",
      id: "r1",
      payload: { query: "shell" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts workflow.create", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "workflow.create",
      id: "r1",
      payload: { name: "deploy" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest rejects workflow.create without name", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "workflow.create",
      id: "r1",
      payload: {},
    }),
    "string",
  );
});

Deno.test("validateServerRequest accepts workflow.delete", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "workflow.delete",
      id: "r1",
      payload: { workflowIdOrName: "deploy" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts workflow.edit", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "workflow.edit",
      id: "r1",
      payload: { workflowIdOrName: "deploy", content: "jobs: {}" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts workflow.validate", () => {
  assertEquals(
    typeof validateServerRequest({ type: "workflow.validate", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts workflow.validate with workflowIdOrName", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "workflow.validate",
      id: "r1",
      payload: { workflowIdOrName: "deploy" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts workflow.evaluate", () => {
  assertEquals(
    typeof validateServerRequest({ type: "workflow.evaluate", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts workflow.evaluate with inputs", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "workflow.evaluate",
      id: "r1",
      payload: { workflowIdOrName: "deploy", inputs: { env: "prod" } },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts vault.create", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "vault.create",
      id: "r1",
      payload: { vaultType: "local_encryption", name: "my-vault" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest rejects vault.create without name", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "vault.create",
      id: "r1",
      payload: { vaultType: "local_encryption" },
    }),
    "string",
  );
});

Deno.test("validateServerRequest accepts vault.edit", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "vault.edit",
      id: "r1",
      payload: { vaultNameOrId: "my-vault" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts vault.audit-trail", () => {
  assertEquals(
    typeof validateServerRequest({ type: "vault.audit-trail", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts vault.audit-trail with filters", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "vault.audit-trail",
      id: "r1",
      payload: { vaultName: "v1", secretKey: "k1", limit: 50 },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts vault.read-secret", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "vault.read-secret",
      id: "r1",
      payload: { vaultName: "my-vault", secretKey: "API_KEY" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest rejects vault.read-secret without secretKey", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "vault.read-secret",
      id: "r1",
      payload: { vaultName: "my-vault" },
    }),
    "string",
  );
});

Deno.test("validateServerRequest accepts vault.type.search", () => {
  assertEquals(
    typeof validateServerRequest({ type: "vault.type.search", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts worker.token.create", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "worker.token.create",
      id: "r1",
      payload: { name: "wt-1", durationMs: 3600000 },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts worker.token.create with unlimited enrollments", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "worker.token.create",
      id: "r1",
      payload: {
        name: "wt-1",
        durationMs: 3600000,
        maxEnrollments: "unlimited",
      },
    }),
    "object",
  );
});

Deno.test("validateServerRequest rejects worker.token.create without durationMs", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "worker.token.create",
      id: "r1",
      payload: { name: "wt-1" },
    }),
    "string",
  );
});

Deno.test("validateServerRequest accepts worker.token.list", () => {
  assertEquals(
    typeof validateServerRequest({ type: "worker.token.list", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts worker.token.revoke", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "worker.token.revoke",
      id: "r1",
      payload: { name: "wt-1" },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts data.gc", () => {
  assertEquals(
    typeof validateServerRequest({ type: "data.gc", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts data.gc with dryRun", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "data.gc",
      id: "r1",
      payload: { dryRun: true },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts data.prune", () => {
  assertEquals(
    typeof validateServerRequest({ type: "data.prune", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts run.gc", () => {
  assertEquals(
    typeof validateServerRequest({ type: "run.gc", id: "r1" }),
    "object",
  );
});

Deno.test("validateServerRequest accepts run.gc with retention options", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "run.gc",
      id: "r1",
      payload: {
        dryRun: true,
        workflowRunRetentionDays: 30,
        outputRetentionDays: 14,
      },
    }),
    "object",
  );
});

Deno.test("validateServerRequest accepts datastore.namespace.list", () => {
  assertEquals(
    typeof validateServerRequest({
      type: "datastore.namespace.list",
      id: "r1",
    }),
    "object",
  );
});

// ── Authorization: new command types (issue #1531) ───────────────────────

Deno.test("authorizeOrReject: access.token.list requires admin on access:*", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({ type: "access.token.list", id: "at-1" })),
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

Deno.test("authorizeOrReject: access.token.revoke requires admin on access:*", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "access.token.revoke",
      id: "at-2",
      payload: { name: "tok" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
});

Deno.test("authorizeOrReject: worker.token.create requires admin on access:*", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "worker.token.create",
      id: "wt-1",
      payload: { name: "wt", durationMs: 3600000 },
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

Deno.test("authorizeOrReject: model.edit requires write on model:<name>", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "model.edit",
      id: "me-1",
      payload: { modelIdOrName: "test-model" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "write",
  );
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "model:test-model",
  );
});

Deno.test("authorizeOrReject: workflow.create requires write on workflow:<name>", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.create",
      id: "wc-1",
      payload: { name: "deploy" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "write",
  );
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "workflow:deploy",
  );
});

Deno.test("authorizeOrReject: vault.read-secret requires read on data:<vault>", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({
      type: "vault.read-secret",
      id: "vrs-1",
      payload: { vaultName: "prod-vault", secretKey: "API_KEY" },
    })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "read",
  );
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "data:prod-vault",
  );
});

Deno.test("authorizeOrReject: data.gc requires write on data:*", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({ type: "data.gc", id: "dgc-1" })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "write",
  );
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "data:*",
  );
});

Deno.test("authorizeOrReject: model.type.search requires read on model:*", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const ctx = makeCtx(modeTokenConfig, []);

  handleMessage(
    mock as unknown as WebSocket,
    ctx,
    active,
    makeEvent(JSON.stringify({ type: "model.type.search", id: "mts-1" })),
    testPrincipal,
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "unauthorized");
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "read",
  );
  assertStringIncludes(
    String((msg.error as Record<string, unknown>).message),
    "model:*",
  );
});

Deno.test("authorizeOrReject: admin on access:* allows all new command types", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();
  const adminGrant = makeGrant({
    subject: { kind: "user", name: "adam" },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
  const ctx = makeCtx(modeTokenConfig, [adminGrant]);

  const newTypes = [
    { type: "access.token.list", id: "admin-atl" },
    {
      type: "access.token.revoke",
      id: "admin-atr",
      payload: { name: "tok" },
    },
    {
      type: "access.token.rotate",
      id: "admin-atro",
      payload: { name: "tok" },
    },
    {
      type: "model.edit",
      id: "admin-me",
      payload: { modelIdOrName: "m" },
    },
    {
      type: "model.type.describe",
      id: "admin-mtd",
      payload: { typeArg: "command/shell" },
    },
    { type: "model.type.search", id: "admin-mts" },
    { type: "workflow.create", id: "admin-wc", payload: { name: "wf" } },
    {
      type: "workflow.delete",
      id: "admin-wd",
      payload: { workflowIdOrName: "wf" },
    },
    {
      type: "workflow.edit",
      id: "admin-we",
      payload: { workflowIdOrName: "wf" },
    },
    { type: "workflow.validate", id: "admin-wv" },
    { type: "workflow.evaluate", id: "admin-wev" },
    {
      type: "vault.create",
      id: "admin-vc",
      payload: { vaultType: "local_encryption", name: "v" },
    },
    {
      type: "vault.edit",
      id: "admin-ve",
      payload: { vaultNameOrId: "v" },
    },
    { type: "vault.audit-trail", id: "admin-vat" },
    {
      type: "vault.read-secret",
      id: "admin-vrs",
      payload: { vaultName: "v", secretKey: "k" },
    },
    { type: "vault.type.search", id: "admin-vts" },
    {
      type: "worker.token.create",
      id: "admin-wtc",
      payload: { name: "wt", durationMs: 3600000 },
    },
    { type: "worker.token.list", id: "admin-wtl" },
    {
      type: "worker.token.revoke",
      id: "admin-wtr",
      payload: { name: "wt" },
    },
    { type: "data.gc", id: "admin-dgc" },
    { type: "data.prune", id: "admin-dp" },
    { type: "run.gc", id: "admin-rgc" },
    { type: "datastore.namespace.list", id: "admin-dnl" },
  ];

  for (const msg of newTypes) {
    handleMessage(
      mock as unknown as WebSocket,
      ctx,
      active,
      makeEvent(JSON.stringify(msg)),
      testPrincipal,
    );
  }

  const unauthorizedErrors = mock.sent
    .map((s) => JSON.parse(s))
    .filter((m) =>
      m.type === "error" &&
      (m.error as Record<string, unknown>).code === "unauthorized"
    );
  assertEquals(
    unauthorizedErrors.length,
    0,
    "admin superuser should not be denied any new command type",
  );
});
