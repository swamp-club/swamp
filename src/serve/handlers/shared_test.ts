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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { gunzipSync } from "node:zlib";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  authorizeAnyOrReject,
  closeConnectionsForPrincipal,
  closeSession,
  COMPRESSION_THRESHOLD_BYTES,
  type ConnectionContext,
  emitSystemAuditEvent,
  filterByAuthorization,
  listTokenSessions,
  paginate,
  removeConnection,
  resolveConnectionCompression,
  send,
  setConnectionCollectives,
  setConnectionCompression,
  setConnectionSourceIp,
  setConnectionTeardown,
  setConnectionToken,
  terminateTokenSessions,
  type TerminateTokenSessionsOptions,
} from "./shared.ts";
import type { ServerMessage } from "../protocol.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "model", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makePrincipal(id: string): Principal {
  return { kind: "user", id };
}

function makeCtx(
  grants: Grant[],
  mode: "none" | "token" | "oauth" = "token",
): ConnectionContext {
  const snapshot = new PolicySnapshot(grants, []);
  const service = new GrantBasedAccessDecisionService(snapshot);
  return {
    repoDir: "/tmp/test",
    repoContext: {} as ConnectionContext["repoContext"],
    datastoreConfig: {
      type: "filesystem",
    } as ConnectionContext["datastoreConfig"],
    datastoreResolver: {} as ConnectionContext["datastoreResolver"],
    policySnapshotLoader: {
      decisionService: service,
    } as unknown as PolicySnapshotLoader,
    authConfig: {
      mode,
      admins: [],
      allowedCollectives: [],
      allowedUsers: [],
      oauthProvider: "",
      groupsField: "groups",
      restrictedModelTypes: [],
      restrictedCommands: [],
      approveRequiresExplicitGrant: false,
    },
  };
}

function makeSocket(): WebSocket {
  return {
    readyState: 1,
    send: () => {},
    OPEN: 1,
  } as unknown as WebSocket;
}

type TestItem = { name: string; type: string };

const testItems: TestItem[] = [
  { name: "@acme/deploy", type: "@acme" },
  { name: "@acme/build", type: "@acme" },
  { name: "@other/run", type: "@other" },
];

Deno.test("filterByAuthorization: returns all items when auth mode is none", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([], "none");
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 3);
});

Deno.test("filterByAuthorization: returns empty when no principal", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
  ]);
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    null,
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 0);
});

Deno.test("filterByAuthorization: returns all items for admin user", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    }),
  ]);
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 3);
});

Deno.test("filterByAuthorization: filters by scoped grant", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "@acme/*" } }),
  ]);
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "@acme/deploy");
  assertEquals(result[1].name, "@acme/build");
});

Deno.test("filterByAuthorization: excludes items with undefined name", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
  ]);
  const items = [
    { modelName: "@acme/deploy" },
    { modelName: undefined },
  ];
  const result = filterByAuthorization(
    items,
    (item) => item.modelName,
    (item) => ({ name: item.modelName }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 1);
});

Deno.test("filterByAuthorization: deny grant excludes matching items", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
    makeGrant({
      effect: "deny",
      resource: { kind: "model", pattern: "@other/*" },
    }),
  ]);
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "@acme/deploy");
  assertEquals(result[1].name, "@acme/build");
});

Deno.test("filterByAuthorization: admin with deny grant respects deny", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    }),
    makeGrant({
      effect: "deny",
      actions: ["read"],
      resource: { kind: "model", pattern: "@secret/*" },
    }),
  ]);
  const itemsWithSecret: TestItem[] = [
    ...testItems,
    { name: "@secret/keys", type: "@secret" },
  ];
  const result = filterByAuthorization(
    itemsWithSecret,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 3);
  assertEquals(result[0].name, "@acme/deploy");
  assertEquals(result[1].name, "@acme/build");
  assertEquals(result[2].name, "@other/run");
});

Deno.test("authorizeAnyOrReject: returns true when auth mode is none", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([], "none");
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result, true);
});

Deno.test("authorizeAnyOrReject: returns false when no principal", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([]);
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    null,
    "read",
    "model",
    ctx,
  );
  assertEquals(result, false);
});

Deno.test("authorizeAnyOrReject: returns true when user has scoped grant", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "@acme/*" } }),
  ]);
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result, true);
});

Deno.test("authorizeAnyOrReject: returns false when no grants exist", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([]);
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result, false);
});

Deno.test("authorizeAnyOrReject: returns true for admin fallback", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    }),
  ]);
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result, true);
});

// ── emitSystemAuditEvent tests ─────────────────────────────────────────

Deno.test("emitSystemAuditEvent: emits event with system category", () => {
  const emitted: unknown[] = [];
  const ctx = {
    auditEmitter: {
      emit(event: unknown) {
        emitted.push(event);
      },
    },
    instanceId: "test-instance",
  } as unknown as ConnectionContext;

  emitSystemAuditEvent(ctx, "instance.start", "version=1.0");

  assertEquals(emitted.length, 1);
  const event = emitted[0] as Record<string, unknown>;
  assertEquals(event.category, "system");
  assertEquals(event.action, "instance.start");
  assertEquals(event.principalKind, "system");
  assertEquals(event.principalId, "system");
  assertEquals(event.detail, "version=1.0");
  assertEquals(event.resourceKind, "server");
});

Deno.test("emitSystemAuditEvent: no-op without emitter", () => {
  const ctx = {} as unknown as ConnectionContext;
  emitSystemAuditEvent(ctx, "instance.start");
});

// ── paginate ──────────────────────────────────────────────────────────────

Deno.test("paginate: slices by offset and limit and reports the full total", () => {
  assertEquals(paginate([1, 2, 3, 4, 5], 1, 2), { page: [2, 3], total: 5 });
});

Deno.test("paginate: omitted offset and limit return everything", () => {
  assertEquals(paginate([1, 2, 3], undefined, undefined), {
    page: [1, 2, 3],
    total: 3,
  });
});

Deno.test("paginate: offset past the end returns an empty page", () => {
  assertEquals(paginate([1, 2], 5, 10), { page: [], total: 2 });
});

// ── WebSocket compression ─────────────────────────────────────────────────

Deno.test("resolveConnectionCompression: reads compress=gzip from the upgrade URL", () => {
  assertEquals(
    resolveConnectionCompression("ws://h/?compress=gzip"),
    "gzip",
  );
  assertEquals(
    resolveConnectionCompression("wss://h/?token=t&compress=gzip"),
    "gzip",
  );
  assertEquals(resolveConnectionCompression("ws://h/"), undefined);
  assertEquals(
    resolveConnectionCompression("ws://h/?compress=br"),
    undefined,
  );
});

function makeFrameSocket(): {
  socket: WebSocket;
  frames: Array<string | Uint8Array>;
} {
  const frames: Array<string | Uint8Array> = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string | Uint8Array) => frames.push(data),
  } as unknown as WebSocket;
  return { socket, frames };
}

function largeMessage(): ServerMessage {
  return {
    type: "workflow.search",
    id: "big",
    payload: {
      data: { results: ["x".repeat(COMPRESSION_THRESHOLD_BYTES)] },
    },
  };
}

Deno.test("send: opted-in socket gets large frames as gzip binary that round-trips", () => {
  const { socket, frames } = makeFrameSocket();
  setConnectionCompression(socket, "gzip");
  const message = largeMessage();

  send(socket, message);

  assertEquals(frames.length, 1);
  const frame = frames[0];
  assertInstanceOf(frame, Uint8Array);
  const decoded = new TextDecoder().decode(gunzipSync(frame));
  assertEquals(decoded, JSON.stringify(message));
});

Deno.test("send: opted-in socket keeps small frames as text", () => {
  const { socket, frames } = makeFrameSocket();
  setConnectionCompression(socket, "gzip");

  send(socket, {
    type: "server.version",
    id: "v",
    payload: { version: "1", gitSha: "abc" },
  });

  assertEquals(typeof frames[0], "string");
});

Deno.test("send: socket without opt-in gets large frames as text", () => {
  const { socket, frames } = makeFrameSocket();
  setConnectionCompression(socket, undefined);
  const message = largeMessage();

  send(socket, message);

  assertEquals(frames[0], JSON.stringify(message));
});

// ── token session binding and termination ───────────────────────────────

interface ClosableSocket {
  socket: WebSocket;
  closes: { code?: number; reason?: string }[];
}

/** A fake socket whose close runs removeConnection, as the upgrade wires it. */
function makeClosableSocket(sourceIp = "192.0.2.10"): ClosableSocket {
  const closes: { code?: number; reason?: string }[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: () => {},
    close: (code?: number, reason?: string) => {
      closes.push({ code, reason });
      removeConnection(socket);
    },
  } as unknown as WebSocket;
  setConnectionSourceIp(socket, sourceIp);
  return { socket, closes };
}

function bindToken(
  name: string,
  createdAt: string,
  principalId = "user:alice",
): ClosableSocket {
  const s = makeClosableSocket();
  setConnectionCollectives(s.socket, [], [], principalId);
  setConnectionToken(s.socket, { name, createdAt, principalId });
  return s;
}

const MINT_1 = "2026-01-01T00:00:00.000Z";
const MINT_2 = "2026-02-02T00:00:00.000Z";

function terminate(
  name: string,
  extra: Partial<TerminateTokenSessionsOptions> = {},
): number {
  return terminateTokenSessions(name, {
    code: 4003,
    reason: "Session revoked",
    cause: "revoked",
    initiatedBy: "user:admin",
    ...extra,
  });
}

function sessionsFor(name: string) {
  return listTokenSessions().filter((s) => s.name === name);
}

Deno.test("terminateTokenSessions: closes every session of the token", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const a = bindToken(name, MINT_1);
  const b = bindToken(name, MINT_1);

  assertEquals(terminate(name), 2);

  assertEquals(a.closes, [{ code: 4003, reason: "Session revoked" }]);
  assertEquals(b.closes, [{ code: 4003, reason: "Session revoked" }]);
  assertEquals(sessionsFor(name), []);
});

Deno.test("terminateTokenSessions: leaves another token of the same principal open", () => {
  const revoked = `tok-${crypto.randomUUID()}`;
  const other = `tok-${crypto.randomUUID()}`;
  const target = bindToken(revoked, MINT_1, "user:alice");
  const survivor = bindToken(other, MINT_1, "user:alice");

  assertEquals(terminate(revoked), 1);

  assertEquals(target.closes.length, 1);
  assertEquals(survivor.closes, []);
  assertEquals(sessionsFor(other), [{ name: other, createdAt: MINT_1 }]);
  terminate(other);
});

Deno.test("terminateTokenSessions: exceptCreatedAt keeps sessions opened with the new mint", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const old = bindToken(name, MINT_1);
  const rotated = bindToken(name, MINT_2);

  assertEquals(terminate(name, { exceptCreatedAt: MINT_2 }), 1);

  assertEquals(old.closes.length, 1);
  assertEquals(rotated.closes, []);
  assertEquals(sessionsFor(name), [{ name, createdAt: MINT_2 }]);
  terminate(name);
});

Deno.test("terminateTokenSessions: onlyCreatedAt closes just that mint", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const old = bindToken(name, MINT_1);
  const rotated = bindToken(name, MINT_2);

  assertEquals(terminate(name, { onlyCreatedAt: MINT_1 }), 1);

  assertEquals(old.closes.length, 1);
  assertEquals(rotated.closes, []);
  terminate(name);
});

Deno.test("terminateTokenSessions: a peer that never completes the close is terminated once", () => {
  // A real socket only fires "close" (and so removeConnection) once the peer
  // answers the close frame. Until then it must not be listed again.
  const name = `tok-${crypto.randomUUID()}`;
  const events: AuditEvent[] = [];
  const closes: number[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: () => {},
    close: (code?: number) => closes.push(code ?? 0),
  } as unknown as WebSocket;
  setConnectionCollectives(socket, [], [], "user:alice");
  setConnectionToken(socket, {
    name,
    createdAt: MINT_1,
    principalId: "user:alice",
  });
  const audit = { emitter: { emit: (e: AuditEvent) => events.push(e) } };

  assertEquals(terminate(name, { audit }), 1);
  assertEquals(sessionsFor(name), []);
  assertEquals(terminate(name, { audit }), 0);

  assertEquals(closes, [4003]);
  assertEquals(events.length, 1);
  removeConnection(socket);
});

Deno.test("terminateTokenSessions: stops the session's work before closing it", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const order: string[] = [];
  const s = bindToken(name, MINT_1);
  setConnectionTeardown(s.socket, () => order.push("teardown"));
  const close = s.socket.close.bind(s.socket);
  s.socket.close = (code?: number, reason?: string) => {
    order.push("close");
    close(code, reason);
  };

  terminate(name);

  assertEquals(order, ["teardown", "close"]);
});

Deno.test("closeConnectionsForPrincipal: stops each session's work before closing it", () => {
  const principalId = `user:${crypto.randomUUID()}`;
  const order: string[] = [];
  const s = makeClosableSocket();
  setConnectionCollectives(s.socket, [], [], principalId);
  setConnectionTeardown(s.socket, () => order.push("teardown"));
  const close = s.socket.close.bind(s.socket);
  s.socket.close = (code?: number, reason?: string) => {
    order.push("close");
    close(code, reason);
  };

  closeConnectionsForPrincipal(principalId);

  assertEquals(order, ["teardown", "close"]);
  assertEquals(s.closes, [{ code: 4003, reason: "Session revoked" }]);
});

Deno.test("closeSession: a failing teardown still closes the socket", () => {
  const s = makeClosableSocket();
  setConnectionTeardown(s.socket, () => {
    throw new Error("boom");
  });

  closeSession(s.socket, 4003, "Session revoked");

  assertEquals(s.closes, [{ code: 4003, reason: "Session revoked" }]);
});

Deno.test("terminateTokenSessions: an unknown token closes nothing", () => {
  assertEquals(terminate(`tok-${crypto.randomUUID()}`), 0);
});

Deno.test("listTokenSessions: reports each open mint once and drops closed ones", () => {
  const name = `tok-${crypto.randomUUID()}`;
  bindToken(name, MINT_1);
  bindToken(name, MINT_1);
  const second = bindToken(name, MINT_2);

  assertEquals(
    sessionsFor(name).sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
    [{ name, createdAt: MINT_1 }, { name, createdAt: MINT_2 }],
  );

  second.socket.close();
  assertEquals(sessionsFor(name), [{ name, createdAt: MINT_1 }]);
  terminate(name);
  assertEquals(sessionsFor(name), []);
});

Deno.test("terminateTokenSessions: audits each closed session before closing it", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const events: AuditEvent[] = [];
  const order: string[] = [];
  const session = makeClosableSocket("198.51.100.7");
  setConnectionCollectives(session.socket, [], [], "user:alice");
  setConnectionToken(session.socket, {
    name,
    createdAt: MINT_1,
    principalId: "user:alice",
  });
  const originalClose = session.socket.close.bind(session.socket);
  session.socket.close = (code?: number, reason?: string) => {
    order.push("close");
    originalClose(code, reason);
  };

  terminate(name, {
    requestId: "req-9",
    audit: {
      instanceId: "instance-1",
      emitter: {
        emit: (event) => {
          order.push("audit");
          events.push(event);
        },
      },
    },
  });

  assertEquals(order, ["audit", "close"]);
  assertEquals(events.length, 1);
  const event = events[0];
  assertEquals(event.category, "auth");
  assertEquals(event.action, "auth.session.terminated");
  assertEquals(event.outcome, "success");
  assertEquals(event.resourceKind, "server-token");
  assertEquals(event.resourceName, name);
  assertEquals(event.principalKind, "user");
  assertEquals(event.principalId, "alice");
  assertEquals(event.initiatedBy, "user:admin");
  assertEquals(event.sourceIp, "198.51.100.7");
  assertEquals(event.requestId, "req-9");
  assertEquals(event.instanceId, "instance-1");
  assertEquals(event.detail, "revoked");
});

Deno.test("terminateTokenSessions: a failing audit emitter still closes the session", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const session = bindToken(name, MINT_1);

  const closed = terminate(name, {
    audit: {
      emitter: {
        emit: () => {
          throw new Error("sink down");
        },
      },
    },
  });

  assertEquals(closed, 1);
  assertEquals(session.closes.length, 1);
});

Deno.test("terminateTokenSessions: without an emitter it closes and records nothing", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const session = bindToken(name, MINT_1);

  assertEquals(terminate(name, { audit: {} }), 1);
  assertEquals(session.closes.length, 1);
});
