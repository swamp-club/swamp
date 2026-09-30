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

import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { gunzipSync } from "node:zlib";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";
import { notFound, validationFailed } from "../../libswamp/mod.ts";
import {
  authorizeAnyOrReject,
  authorizeOrReject,
  cancelActor,
  cancelReasonFor,
  clientErrorDetails,
  closeConnectionsForPrincipal,
  closeSession,
  COMPRESSION_THRESHOLD_BYTES,
  type ConnectionContext,
  emitRunCancelAudit,
  emitSystemAuditEvent,
  filterByResources,
  isAccessModelType,
  isAuthorized,
  LibSwampStreamError,
  listTokenSessions,
  MAX_STREAM_SESSIONS_PER_PRINCIPAL,
  MAX_STREAM_SESSIONS_PER_TOKEN,
  paginate,
  registerStreamSession,
  removeConnection,
  resolveConnectionCompression,
  resolveDisplayPrincipal,
  send,
  setConnectionCollectives,
  setConnectionCompression,
  setConnectionSourceIp,
  setConnectionTeardown,
  setConnectionToken,
  terminateTokenSessions,
  type TerminateTokenSessionsOptions,
  updateCollectivesForPrincipal,
} from "./shared.ts";
import type { ServerMessage } from "../protocol.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { createConditionEvaluator } from "../../domain/access/policy_snapshot_loader.ts";

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
  const snapshot = new PolicySnapshot(grants, [], createConditionEvaluator());
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

Deno.test("filterByResources: returns all items when auth mode is none", async () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([], "none");
  const result = await filterByResources(
    testItems,
    (item) =>
      Promise.resolve(
        item.name === undefined ? [] : [{
          kind: "model",
          name: item.name,
          fields: { name: item.name, tags: {} },
        }],
      ),
    socket,
    makePrincipal("adam"),
    "read",
    ctx,
  );
  assertEquals(result.length, 3);
});

Deno.test("filterByResources: returns empty when no principal", async () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
  ]);
  const result = await filterByResources(
    testItems,
    (item) =>
      Promise.resolve(
        item.name === undefined ? [] : [{
          kind: "model",
          name: item.name,
          fields: { name: item.name, tags: {} },
        }],
      ),
    socket,
    null,
    "read",
    ctx,
  );
  assertEquals(result.length, 0);
});

Deno.test("filterByResources: returns all items for admin user", async () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    }),
  ]);
  const result = await filterByResources(
    testItems,
    (item) =>
      Promise.resolve(
        item.name === undefined ? [] : [{
          kind: "model",
          name: item.name,
          fields: { name: item.name, tags: {} },
        }],
      ),
    socket,
    makePrincipal("adam"),
    "read",
    ctx,
  );
  assertEquals(result.length, 3);
});

Deno.test("filterByResources: filters by scoped grant", async () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "@acme/*" } }),
  ]);
  const result = await filterByResources(
    testItems,
    (item) =>
      Promise.resolve(
        item.name === undefined ? [] : [{
          kind: "model",
          name: item.name,
          fields: { name: item.name, tags: {} },
        }],
      ),
    socket,
    makePrincipal("adam"),
    "read",
    ctx,
  );
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "@acme/deploy");
  assertEquals(result[1].name, "@acme/build");
});

Deno.test("filterByResources: excludes items with undefined name", async () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
  ]);
  const items = [
    { modelName: "@acme/deploy" },
    { modelName: undefined },
  ];
  const result = await filterByResources(
    items,
    (item) =>
      Promise.resolve(
        item.modelName === undefined ? [] : [{
          kind: "model",
          name: item.modelName,
          fields: { name: item.modelName, tags: {} },
        }],
      ),
    socket,
    makePrincipal("adam"),
    "read",
    ctx,
  );
  assertEquals(result.length, 1);
});

Deno.test("filterByResources: deny grant excludes matching items", async () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
    makeGrant({
      effect: "deny",
      resource: { kind: "model", pattern: "@other/*" },
    }),
  ]);
  const result = await filterByResources(
    testItems,
    (item) =>
      Promise.resolve(
        item.name === undefined ? [] : [{
          kind: "model",
          name: item.name,
          fields: { name: item.name, tags: {} },
        }],
      ),
    socket,
    makePrincipal("adam"),
    "read",
    ctx,
  );
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "@acme/deploy");
  assertEquals(result[1].name, "@acme/build");
});

Deno.test("filterByResources: admin with deny grant respects deny", async () => {
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
  const result = await filterByResources(
    itemsWithSecret,
    (item) =>
      Promise.resolve(
        item.name === undefined ? [] : [{
          kind: "model",
          name: item.name,
          fields: { name: item.name, tags: {} },
        }],
      ),
    socket,
    makePrincipal("adam"),
    "read",
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
  assertEquals(s.closes, [{
    code: 4003,
    reason: "Session revoked: access removed",
  }]);
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

Deno.test("clientErrorDetails: forwards reason and entity type from notFound", () => {
  const error = new LibSwampStreamError(notFound("Data", "secret-name"));
  assertEquals(clientErrorDetails(error), {
    reason: "not_found",
    entityType: "Data",
  });
});

Deno.test("clientErrorDetails: never forwards the identifier", () => {
  const details = clientErrorDetails(
    new LibSwampStreamError(notFound("Model", "/Users/me/secret")),
  );
  assertEquals(JSON.stringify(details).includes("secret"), false);
});

Deno.test("clientErrorDetails: drops entity types outside the allow-list", () => {
  const error = new LibSwampStreamError(notFound("Vault", "x"));
  assertEquals(clientErrorDetails(error), { reason: "not_found" });
});

Deno.test("clientErrorDetails: forwards data_pending without details", () => {
  const error = new LibSwampStreamError({
    code: "data_pending",
    message: "The run is still in progress",
  });
  assertEquals(clientErrorDetails(error), { reason: "data_pending" });
});

Deno.test("clientErrorDetails: forwards validation_failed without its details", () => {
  const error = new LibSwampStreamError(
    validationFailed("bad input", { field: "secret" }),
  );
  assertEquals(clientErrorDetails(error), { reason: "validation_failed" });
});

Deno.test("clientErrorDetails: ignores codes outside the allow-list", () => {
  const error = new LibSwampStreamError({
    code: "not_authenticated",
    message: "nope",
  });
  assertEquals(clientErrorDetails(error), undefined);
});

Deno.test("clientErrorDetails: ignores plain errors", () => {
  assertEquals(clientErrorDetails(new Error("boom")), undefined);
  assertEquals(clientErrorDetails("boom"), undefined);
});

interface FakeStream {
  closes: { code: number; reason: string }[];
  unregister: () => void;
}

function openStream(
  name: string,
  createdAt: string,
  principalId = `user:${crypto.randomUUID()}`,
  sourceIp = "192.0.2.20",
): FakeStream {
  const closes: { code: number; reason: string }[] = [];
  const unregister = registerStreamSession(
    { name, createdAt, principalId },
    { sourceIp, close: (code, reason) => closes.push({ code, reason }) },
  );
  if (unregister === null) throw new Error("stream refused at the cap");
  return { closes, unregister };
}

Deno.test("registerStreamSession: a stream is listed as a token session until unregistered", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const stream = openStream(name, MINT_1);

  assertEquals(sessionsFor(name), [{ name, createdAt: MINT_1 }]);

  stream.unregister();
  stream.unregister();
  assertEquals(sessionsFor(name), []);
});

Deno.test("listTokenSessions: reports a mint shared by a socket and a stream once", () => {
  const name = `tok-${crypto.randomUUID()}`;
  bindToken(name, MINT_1);
  const stream = openStream(name, MINT_1);
  openStream(name, MINT_2);

  assertEquals(sessionsFor(name), [
    { name, createdAt: MINT_1 },
    { name, createdAt: MINT_2 },
  ]);

  terminate(name);
  stream.unregister();
});

Deno.test("terminateTokenSessions: closes the token's streams and counts them", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const socket = bindToken(name, MINT_1);
  const stream = openStream(name, MINT_1);

  assertEquals(terminate(name), 2);

  assertEquals(socket.closes, [{ code: 4003, reason: "Session revoked" }]);
  assertEquals(stream.closes, [{ code: 4003, reason: "Session revoked" }]);
  assertEquals(sessionsFor(name), []);
});

Deno.test("terminateTokenSessions: mint filters apply to streams", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const oldMint = openStream(name, MINT_1);
  const newMint = openStream(name, MINT_2);

  assertEquals(terminate(name, { exceptCreatedAt: MINT_2 }), 1);
  assertEquals(oldMint.closes.length, 1);
  assertEquals(newMint.closes, []);

  assertEquals(terminate(name, { onlyCreatedAt: MINT_1 }), 0);
  assertEquals(terminate(name, { onlyCreatedAt: MINT_2 }), 1);
  assertEquals(newMint.closes.length, 1);
});

Deno.test("terminateTokenSessions: unregisters a stream before closing it, so it closes once", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const listedAtClose: number[] = [];
  const unregister = registerStreamSession(
    { name, createdAt: MINT_1, principalId: "user:alice" },
    {
      sourceIp: "192.0.2.20",
      close: () => listedAtClose.push(sessionsFor(name).length),
    },
  );

  assertEquals(terminate(name), 1);
  assertEquals(terminate(name), 0);
  assertEquals(listedAtClose, [0]);
  unregister?.();
});

Deno.test("terminateTokenSessions: a stream whose close throws does not stop the others", () => {
  const name = `tok-${crypto.randomUUID()}`;
  registerStreamSession(
    { name, createdAt: MINT_1, principalId: "user:alice" },
    {
      sourceIp: "192.0.2.20",
      close: () => {
        throw new Error("boom");
      },
    },
  );
  const other = openStream(name, MINT_1);

  assertEquals(terminate(name), 2);
  assertEquals(other.closes.length, 1);
  assertEquals(sessionsFor(name), []);
});

Deno.test("terminateTokenSessions: audits a closed stream with its principal and source IP", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const events: AuditEvent[] = [];
  const order: string[] = [];
  registerStreamSession(
    { name, createdAt: MINT_1, principalId: "user:bob" },
    { sourceIp: "203.0.113.9", close: () => order.push("close") },
  );

  terminate(name, {
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
  assertEquals(events[0].action, "auth.session.terminated");
  assertEquals(events[0].resourceName, name);
  assertEquals(events[0].principalId, "bob");
  assertEquals(events[0].sourceIp, "203.0.113.9");
  assertEquals(events[0].detail, "revoked");
});

Deno.test("closeConnectionsForPrincipal: closes that principal's streams and keeps others", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const principal = `user:${crypto.randomUUID()}`;
  const mine = openStream(name, MINT_1, principal);
  const theirs = openStream(`tok-${crypto.randomUUID()}`, MINT_1, "user:other");

  closeConnectionsForPrincipal(principal);

  assertEquals(mine.closes, [{
    code: 4003,
    reason: "Session revoked: access removed",
  }]);
  assertEquals(theirs.closes, []);
  assertEquals(sessionsFor(name), []);
  theirs.unregister();
});

Deno.test("registerStreamSession: refuses a token's stream past the cap, across mints", () => {
  const name = `tok-${crypto.randomUUID()}`;
  const streams = Array.from(
    { length: MAX_STREAM_SESSIONS_PER_TOKEN },
    (_, i) => openStream(name, i % 2 === 0 ? MINT_1 : MINT_2),
  );
  const other = openStream(`tok-${crypto.randomUUID()}`, MINT_1);

  const refused = registerStreamSession(
    { name, createdAt: MINT_2, principalId: "user:alice" },
    { sourceIp: "192.0.2.20", close: () => {} },
  );
  assertEquals(refused, null);

  streams[0].unregister();
  const freed = registerStreamSession(
    { name, createdAt: MINT_1, principalId: "user:alice" },
    { sourceIp: "192.0.2.20", close: () => {} },
  );
  assertEquals(typeof freed, "function");

  freed?.();
  for (const stream of streams) stream.unregister();
  other.unregister();
  assertEquals(sessionsFor(name), []);
});

Deno.test("registerStreamSession: refuses a principal's stream past the cap, across tokens", () => {
  const principal = `user:${crypto.randomUUID()}`;
  const names = Array.from(
    { length: 3 },
    () => `tok-${crypto.randomUUID()}`,
  );
  const streams = Array.from(
    { length: MAX_STREAM_SESSIONS_PER_PRINCIPAL },
    (_, i) => openStream(names[i % 2], MINT_1, principal),
  );
  const someoneElse = openStream(names[2], MINT_1);

  const refused = registerStreamSession(
    { name: names[2], createdAt: MINT_1, principalId: principal },
    { sourceIp: "192.0.2.20", close: () => {} },
  );
  assertEquals(refused, null);

  streams[0].unregister();
  const freed = openStream(names[2], MINT_1, principal);

  freed.unregister();
  for (const stream of streams) stream.unregister();
  someoneElse.unregister();
  for (const name of names) assertEquals(sessionsFor(name), []);
});

Deno.test("registerStreamSession: a principal's streams closed by revocation free its cap", () => {
  const principal = `user:${crypto.randomUUID()}`;
  const names = [`tok-${crypto.randomUUID()}`, `tok-${crypto.randomUUID()}`];
  for (let i = 0; i < MAX_STREAM_SESSIONS_PER_PRINCIPAL; i++) {
    openStream(names[i % 2], MINT_1, principal);
  }

  closeConnectionsForPrincipal(principal);
  const reopened = openStream(names[0], MINT_1, principal);

  reopened.unregister();
  for (const name of names) assertEquals(sessionsFor(name), []);
});

Deno.test("updateCollectivesForPrincipal: ends that principal's streams so they reconnect with the new access", () => {
  const principal = `user:${crypto.randomUUID()}`;
  const name = `tok-${crypto.randomUUID()}`;
  const mine = openStream(name, MINT_1, principal);
  const theirs = openStream(`tok-${crypto.randomUUID()}`, MINT_1, "user:other");

  updateCollectivesForPrincipal(principal, ["team-b"], []);

  assertEquals(mine.closes, [{
    code: 4004,
    reason: "Session ended: access changed, reconnect",
  }]);
  assertEquals(theirs.closes, []);
  assertEquals(sessionsFor(name), []);
  theirs.unregister();
});

function recordingSocket(): { socket: WebSocket; frames: string[] } {
  const frames: string[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (frame: string) => frames.push(frame),
  } as unknown as WebSocket;
  return { socket, frames };
}

function withAuditLog(ctx: ConnectionContext): AuditEvent[] {
  const events: AuditEvent[] = [];
  ctx.auditEmitter = {
    emit: (event: AuditEvent) => events.push(event),
  } as unknown as ConnectionContext["auditEmitter"];
  ctx.instanceId = "test-instance";
  return events;
}

const deployWorkflow = {
  kind: "workflow" as const,
  name: "deploy",
  fields: { name: "deploy" },
};

Deno.test("isAuthorized: allows a scoped grant without sending anything", () => {
  const { socket, frames } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({
      actions: ["run"],
      resource: { kind: "workflow", pattern: "deploy" },
    }),
  ]);
  const audit = withAuditLog(ctx);

  assertEquals(
    isAuthorized(
      socket,
      "req-1",
      makePrincipal("adam"),
      "run",
      deployWorkflow,
      ctx,
    ),
    true,
  );
  assertEquals(frames, []);
  assertEquals(audit, []);
});

Deno.test("isAuthorized: refuses silently and audits the denial", () => {
  const { socket, frames } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([]);
  const audit = withAuditLog(ctx);

  assertEquals(
    isAuthorized(
      socket,
      "req-1",
      makePrincipal("adam"),
      "run",
      deployWorkflow,
      ctx,
    ),
    false,
  );
  assertEquals(frames, []);
  assertEquals(audit.length, 1);
  assertEquals(audit[0].outcome, "denied");
  assertEquals(audit[0].resourceName, "deploy");
  assertEquals(audit[0].requestId, "req-1");
});

Deno.test("isAuthorized: refuses silently without a principal or a policy snapshot", () => {
  const { socket, frames } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([]);
  const audit = withAuditLog(ctx);

  assertEquals(
    isAuthorized(socket, "req-1", null, "run", deployWorkflow, ctx),
    false,
  );
  ctx.policySnapshotLoader = undefined;
  assertEquals(
    isAuthorized(
      socket,
      "req-2",
      makePrincipal("adam"),
      "run",
      deployWorkflow,
      ctx,
    ),
    false,
  );
  assertEquals(frames, []);
  assertEquals(audit.map((e) => e.detail), [
    "no_principal",
    "access_not_configured",
  ]);
});

Deno.test("isAuthorized: allows everything when auth mode is none", () => {
  const { socket, frames } = recordingSocket();
  const ctx = makeCtx([], "none");
  assertEquals(
    isAuthorized(socket, "req-1", null, "run", deployWorkflow, ctx),
    true,
  );
  assertEquals(frames, []);
});

Deno.test("isAuthorized: decides as authorizeOrReject does", () => {
  const cases: { name: string; grants: Grant[] }[] = [
    { name: "no grants", grants: [] },
    {
      name: "scoped grant",
      grants: [makeGrant({
        actions: ["run"],
        resource: { kind: "workflow", pattern: "deploy" },
      })],
    },
    {
      name: "admin fallback",
      grants: [makeGrant({
        actions: ["admin"],
        resource: { kind: "access", pattern: "*" },
      })],
    },
    {
      name: "admin with explicit deny",
      grants: [
        makeGrant({
          actions: ["admin"],
          resource: { kind: "access", pattern: "*" },
        }),
        makeGrant({
          effect: "deny",
          actions: ["run"],
          resource: { kind: "workflow", pattern: "deploy" },
        }),
      ],
    },
  ];
  for (const { name, grants } of cases) {
    const { socket } = recordingSocket();
    setConnectionCollectives(socket, [], []);
    const ctx = makeCtx(grants);
    const expected = authorizeOrReject(
      socket,
      "req-1",
      makePrincipal("adam"),
      "run",
      deployWorkflow,
      ctx,
    ).allowed;
    assertEquals(
      isAuthorized(
        socket,
        "req-2",
        makePrincipal("adam"),
        "run",
        deployWorkflow,
        ctx,
      ),
      expected,
      name,
    );
  }
});

Deno.test("resolveDisplayPrincipal: names a user by resolved name, else the principal", () => {
  assertEquals(resolveDisplayPrincipal(makePrincipal("u-1"), {}), "user:u-1");
  assertEquals(
    resolveDisplayPrincipal(makePrincipal("u-1"), {
      resolvedUserNames: { "u-1": "alice" },
    }),
    "user:alice",
  );
  assertEquals(
    resolveDisplayPrincipal(makePrincipal("u-1"), {
      resolvedUserNames: { "u-2": "bob" },
    }),
    "user:u-1",
  );
  // Only user principals are looked up by name.
  assertEquals(
    resolveDisplayPrincipal({ kind: "worker", id: "u-1" }, {
      resolvedUserNames: { "u-1": "alice" },
    }),
    "worker:u-1",
  );
});

Deno.test("cancelActor: names the principal, its resolved user name, or anonymous", () => {
  assertEquals(cancelActor(null, {}), "anonymous");
  assertEquals(cancelActor(makePrincipal("u-1"), {}), "user:u-1");
  assertEquals(
    cancelActor(makePrincipal("u-1"), {
      resolvedUserNames: { "u-1": "alice" },
    }),
    "user:alice",
  );
});

Deno.test("cancelReasonFor: records who cancelled, with any reason given", () => {
  assertEquals(cancelReasonFor("user:alice"), "cancelled by user:alice");
  assertEquals(
    cancelReasonFor("user:alice", "stuck gate"),
    "stuck gate (cancelled by user:alice)",
  );
});

Deno.test("emitRunCancelAudit: records the cancel, its outcome and who made it", () => {
  const events: AuditEvent[] = [];
  const ctx = {
    instanceId: "inst-1",
    resolvedUserNames: { "u-1": "alice" },
    auditEmitter: { emit: (e: AuditEvent) => events.push(e) },
  } as unknown as ConnectionContext;

  emitRunCancelAudit(ctx, {
    action: "cancel",
    resourceKind: "workflow",
    resourceName: "run-1",
    principal: makePrincipal("u-1"),
    sourceIp: "10.0.0.1",
    requestId: "req-1",
    outcome: "success",
    detail: "workflow=deploy",
  });
  emitRunCancelAudit(ctx, {
    action: "cancel.all",
    resourceKind: "execution",
    resourceName: "*",
    principal: null,
    sourceIp: "10.0.0.2",
    requestId: "req-2",
    outcome: "success",
    detail: "count=3",
  });

  assertEquals(events.length, 2);
  assertEquals(events[0].category, "execution");
  assertEquals(events[0].action, "cancel");
  assertEquals(events[0].outcome, "success");
  assertEquals(events[0].resourceName, "run-1");
  assertEquals(events[0].principalId, "u-1");
  assertEquals(events[0].initiatedBy, "user:alice");
  assertEquals(events[0].sourceIp, "10.0.0.1");
  assertEquals(events[0].detail, "workflow=deploy");
  assertEquals(events[1].action, "cancel.all");
  assertEquals(events[1].principalKind, "anonymous");
  assertEquals(events[1].initiatedBy, "ghost");
});

Deno.test("filterByResources: keeps an item only when every owner is allowed", async () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "data", pattern: "*" } }),
    makeGrant({
      effect: "deny",
      resource: { kind: "data", pattern: "prod-db" },
    }),
  ]);
  const owner = (name: string) => ({
    kind: "data" as const,
    name,
    fields: { name, ns: "", tags: {} },
  });
  const items = [
    { owners: [owner("dev-db")] },
    { owners: [owner("dev-db"), owner("prod-db")] },
  ];
  const result = await filterByResources(
    items,
    (item) => Promise.resolve(item.owners),
    socket,
    makePrincipal("adam"),
    "read",
    ctx,
  );
  assertEquals(result, [items[0]]);
});

Deno.test("filterByResources: a tags deny drops the tagged item and keeps an untagged one", async () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
    makeGrant({
      effect: "deny",
      resource: { kind: "model", pattern: "*" },
      condition: '"env" in tags && tags.env == "prod"',
    }),
  ]);
  const items = [
    { name: "a", tags: { env: "prod" } },
    { name: "b", tags: {} },
  ];
  const result = await filterByResources(
    items,
    (item) =>
      Promise.resolve([{
        kind: "model" as const,
        name: item.name,
        fields: { name: item.name, modelType: "t", tags: item.tags },
      }]),
    socket,
    makePrincipal("adam"),
    "read",
    ctx,
  );
  assertEquals(result.map((i) => i.name), ["b"]);
});

Deno.test("isAccessModelType: every control-plane type, bare or @-prefixed, is admin-only", () => {
  for (
    const type of [
      "swamp/grant",
      "@swamp/group",
      "swamp::server-token",
      "swamp/enrollment-token",
      "swamp/worker",
      "swamp/step-lease",
      "@swamp/pending-dispatch",
      "SWAMP.fleet-probe",
    ]
  ) {
    assertEquals(isAccessModelType(type, undefined), true, type);
    // Resolved types come normalized, with or without the @.
    assertEquals(
      isAccessModelType(undefined, type.toLowerCase().replace(/::|\./g, "/")),
      true,
      type,
    );
  }
  assertEquals(isAccessModelType("command/shell", "command/shell"), false);
});

Deno.test("isAccessModelType: a blank or separator-only typeArg fails the request", () => {
  for (const typeArg of ["::", "/", " "]) {
    assertThrows(() => isAccessModelType(typeArg, undefined));
  }
});
