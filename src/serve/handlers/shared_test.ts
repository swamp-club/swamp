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

import { UserError } from "../../domain/errors.ts";
import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  COMMIT_PARTLY_COMMITTED_CODE,
  COMMIT_UNREACHABLE_CODE,
  CommitUnreachableError,
  RUN_PARTLY_COMMITTED_CODE,
  RunPartlyCommittedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { V3ReplicationError } from "../../domain/datastore_v3/litestream_replication.ts";
import { WriterFencedError } from "../../domain/datastore_v3/writer_lease.ts";
import { gunzipSync } from "node:zlib";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { ModelType } from "../../domain/models/model_type.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";
import { notFound, validationFailed } from "../../libswamp/errors.ts";
import {
  authorizeAnyOrReject,
  authorizeOrReject,
  authorizeRetag,
  cancelActor,
  cancelReasonFor,
  captureDecisionSubject,
  clientErrorDetails,
  closeConnectionsForPrincipal,
  closeSession,
  COMPRESSION_THRESHOLD_BYTES,
  confirmRequest,
  confirmRunReplicated,
  connectionActorIdentity,
  type ConnectionContext,
  decideSubjectAccess,
  emitRunCancelAudit,
  emitSystemAuditEvent,
  filterByResources,
  isAccessModelType,
  isAdminOnlyModelType,
  isAuthorized,
  isAuthorizedForAll,
  isServerFailureCode,
  LibSwampStreamError,
  listTokenSessions,
  MAX_STREAM_SESSIONS_PER_PRINCIPAL,
  MAX_STREAM_SESSIONS_PER_TOKEN,
  paginate,
  pushChangedToRemote,
  registerStreamSession,
  removeConnection,
  replicationErrorForClient,
  resolveConnectionCompression,
  resolveDisplayPrincipal,
  runFailureForClient,
  sanitizeErrorForClient,
  send,
  sendError,
  sendTraced,
  setConnectionCollectives,
  setConnectionCompression,
  setConnectionLoginIdentity,
  setConnectionSourceIp,
  setConnectionTeardown,
  setConnectionToken,
  terminateTokenSessions,
  type TerminateTokenSessionsOptions,
  updateCollectivesForPrincipal,
  withCommittedUnknownSteps,
} from "./shared.ts";
import type { ServerMessage } from "../protocol.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { createConditionEvaluator } from "../../domain/access/policy_snapshot_loader.ts";
import {
  SpanStatusCode,
  withServerSpan,
} from "../../infrastructure/tracing/mod.ts";
import {
  findSpan,
  isChildOf,
  withCapturedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";

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
      signalRequiresExplicitGrant: false,
      tagRequiresExplicitGrant: false,
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

Deno.test("clientErrorDetails: forwards the retention watermark of a not_found", () => {
  const base = notFound("Workflow run", "abc");
  const error = new LibSwampStreamError({
    ...base,
    details: {
      ...(base.details as Record<string, unknown>),
      reapedBefore: "2026-10-01T00:00:00.000Z",
      retention: "14d",
    },
  });
  assertEquals(clientErrorDetails(error), {
    reason: "not_found",
    entityType: "Workflow run",
    reapedBefore: "2026-10-01T00:00:00.000Z",
    retention: "14d",
  });
});

Deno.test("clientErrorDetails: drops a malformed retention watermark", () => {
  const error = new LibSwampStreamError({
    code: "not_found",
    message: "gone",
    details: { reapedBefore: "/Users/me/secret", retention: "14d" },
  });
  assertEquals(clientErrorDetails(error), { reason: "not_found" });
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

Deno.test("emitRunCancelAudit: records the caller's login identity, falling back to the configured name (swamp-club#3076)", () => {
  const events: AuditEvent[] = [];
  const ctx = {
    instanceId: "inst-1",
    resolvedUserNames: { "u-admin": "admin-name" },
    auditEmitter: { emit: (e: AuditEvent) => events.push(e) },
  } as unknown as ConnectionContext;
  const cancel = {
    action: "cancel",
    resourceKind: "workflow",
    resourceName: "run-1",
    sourceIp: "10.0.0.1",
    requestId: "req-1",
    outcome: "success" as const,
  };

  emitRunCancelAudit(ctx, {
    ...cancel,
    principal: makePrincipal("u-collective"),
    loginIdentity: { email: "member@example.com" },
  });
  emitRunCancelAudit(ctx, {
    ...cancel,
    principal: makePrincipal("u-admin"),
    loginIdentity: { email: "admin@example.com" },
  });
  emitRunCancelAudit(ctx, {
    ...cancel,
    principal: { kind: "worker", id: "runner" },
  });

  assertEquals(events[0].principalEmail, "member@example.com");
  assertEquals("principalUsername" in events[0], false);
  assertEquals(events[1].principalUsername, "admin-name");
  assertEquals(events[1].principalEmail, "admin@example.com");
  assertEquals("principalEmail" in events[2], false);
  assertEquals("principalUsername" in events[2], false);
});

Deno.test("isAuthorized: a denial names a collective-admitted user by their login identity (swamp-club#3076)", () => {
  const { socket } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  setConnectionLoginIdentity(socket, {
    email: "member@example.com",
    username: "member",
  });
  const ctx = makeCtx([]);
  const audit = withAuditLog(ctx);

  isAuthorized(
    socket,
    "req-1",
    makePrincipal("sub-member"),
    "run",
    deployWorkflow,
    ctx,
  );

  assertEquals(audit[0].principalId, "sub-member");
  assertEquals(audit[0].principalUsername, "member");
  assertEquals(audit[0].principalEmail, "member@example.com");
});

Deno.test("connectionActorIdentity: nothing known for a socket without a login identity", () => {
  const { socket } = recordingSocket();
  setConnectionLoginIdentity(socket, undefined);
  assertEquals(
    connectionActorIdentity(socket, makePrincipal("sub-1"), {}),
    undefined,
  );
  assertEquals(
    connectionActorIdentity(socket, makePrincipal("sub-1"), {
      resolvedUserNames: { "sub-1": "alice" },
    }),
    { username: "alice" },
  );
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
      isAccessModelType(undefined, ModelType.create(type).normalized),
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

Deno.test("isAccessModelType: odd spellings of a control-plane type are admin-only", () => {
  for (const type of [" @swamp/grant", "@@swamp/group", "@/@swamp/worker"]) {
    assertEquals(isAccessModelType(type, undefined), true, type);
  }
});

// --- isAdminOnlyModelType (swamp-club#3129) ---------------------------------

const REQUESTED_SPELLINGS = [
  "@exp/probe",
  "exp/probe",
  " @exp/probe",
  "@@exp/probe",
  "@/@exp/probe",
  "@Exp::Probe",
];

Deno.test("isAdminOnlyModelType: either list spelling restricts every requested spelling", () => {
  for (const listed of ["@exp/probe", "exp/probe", "@Exp::Probe"]) {
    for (const requested of REQUESTED_SPELLINGS) {
      assertEquals(
        isAdminOnlyModelType(requested, undefined, [listed]),
        true,
        `listed ${listed}, requested ${requested}`,
      );
    }
  }
});

Deno.test("isAdminOnlyModelType: either list spelling restricts the stored type", () => {
  for (const listed of ["@exp/probe", "exp/probe", "@Exp::Probe"]) {
    for (const stored of ["@exp/probe", "exp/probe"]) {
      assertEquals(
        isAdminOnlyModelType(undefined, stored, [listed]),
        true,
        `listed ${listed}, stored ${stored}`,
      );
    }
  }
});

Deno.test("isAdminOnlyModelType: a built-in requested with an @ is restricted by its bare entry", () => {
  assertEquals(
    isAdminOnlyModelType("@command/shell", undefined, ["command/shell"]),
    true,
  );
  assertEquals(
    isAdminOnlyModelType(undefined, "command/shell", ["@command/shell"]),
    true,
  );
});

Deno.test("isAdminOnlyModelType: other types stay unrestricted", () => {
  assertEquals(
    isAdminOnlyModelType("@exp/other", "@exp/other", ["@exp/probe"]),
    false,
  );
  assertEquals(isAdminOnlyModelType("@exp/probe", "@exp/probe", []), false);
});

Deno.test("isAdminOnlyModelType: a requested type that names no type fails the request", () => {
  for (const typeArg of ["@", "::", "@/"]) {
    assertThrows(
      () => isAdminOnlyModelType(typeArg, undefined, ["exp/probe"]),
      Error,
      "Invalid behavior type",
    );
  }
});

// --- decideSubjectAccess (swamp-club#2736) ----------------------------------

interface TokenRecordFields {
  state?: "active" | "expired" | "revoked";
  principalId?: string;
  createdAt?: string;
  expiresAt?: string;
  groups?: string[];
}

/** A context whose repository answers one server token record. */
function withTokenRecord(
  ctx: ConnectionContext,
  fields: TokenRecordFields | null,
): ConnectionContext {
  const record = fields === null ? null : {
    name: "tok",
    state: fields.state ?? "active",
    principalId: fields.principalId ?? "user:adam",
    principalEmail: "adam@example.com",
    collectives: [],
    groups: fields.groups ?? [],
    createdAt: fields.createdAt ?? "2026-01-01T00:00:00.000Z",
    expiresAt: fields.expiresAt ?? "2999-01-01T00:00:00.000Z",
    vaultName: "v",
    secretKey: "k",
  };
  ctx.repoContext = {
    definitionRepo: {
      findByName: () => Promise.resolve(record ? { id: "def-1" } : null),
    },
    unifiedDataRepo: {
      getContent: () =>
        Promise.resolve(
          record ? new TextEncoder().encode(JSON.stringify(record)) : null,
        ),
    },
  } as unknown as ConnectionContext["repoContext"];
  return ctx;
}

function subjectOn(): ReturnType<typeof captureDecisionSubject> {
  const socket = makeSocket();
  setConnectionToken(socket, {
    name: "tok",
    createdAt: "2026-01-01T00:00:00.000Z",
    principalId: "user:adam",
  });
  return captureDecisionSubject(socket, makePrincipal("adam"));
}

const approveDeploy = makeGrant({
  actions: ["approve"],
  resource: { kind: "workflow", pattern: "deploy" },
});

Deno.test("decideSubjectAccess: allows a grant the captured token still holds", async () => {
  const ctx = withTokenRecord(makeCtx([approveDeploy]), {});
  assertEquals(
    await decideSubjectAccess(ctx, subjectOn(), "approve", deployWorkflow),
    true,
  );
  assertEquals(
    await decideSubjectAccess(ctx, subjectOn(), "run", deployWorkflow),
    false,
  );
});

Deno.test("decideSubjectAccess: reads group memberships from the token record, not the socket", async () => {
  const grant = makeGrant({
    subject: { kind: "idp-group", name: "release" },
    actions: ["approve"],
    resource: { kind: "workflow", pattern: "deploy" },
  });
  const member = withTokenRecord(makeCtx([grant]), { groups: ["release"] });
  assertEquals(
    await decideSubjectAccess(member, subjectOn(), "approve", deployWorkflow),
    true,
  );
  // Removed from the group since the subject was captured.
  const removed = withTokenRecord(makeCtx([grant]), { groups: [] });
  assertEquals(
    await decideSubjectAccess(removed, subjectOn(), "approve", deployWorkflow),
    false,
  );
});

Deno.test("decideSubjectAccess: refuses a revoked, expired, rotated, foreign or missing token", async () => {
  const cases: (TokenRecordFields | null)[] = [
    { state: "revoked" },
    { expiresAt: "2020-01-01T00:00:00.000Z" },
    { createdAt: "2026-02-02T00:00:00.000Z" },
    { principalId: "user:eve" },
    null,
  ];
  for (const fields of cases) {
    const ctx = withTokenRecord(makeCtx([approveDeploy]), fields);
    assertEquals(
      await decideSubjectAccess(ctx, subjectOn(), "approve", deployWorkflow),
      false,
      JSON.stringify(fields),
    );
  }
});

Deno.test("decideSubjectAccess: refuses a subject with no token or no principal, and allows everything with auth off", async () => {
  const ctx = withTokenRecord(makeCtx([approveDeploy]), {});
  assertEquals(
    await decideSubjectAccess(
      ctx,
      { principal: makePrincipal("adam") },
      "approve",
      deployWorkflow,
    ),
    false,
  );
  assertEquals(
    await decideSubjectAccess(
      ctx,
      { principal: null },
      "approve",
      deployWorkflow,
    ),
    false,
  );
  assertEquals(
    await decideSubjectAccess(
      makeCtx([], "none"),
      { principal: null },
      "approve",
      deployWorkflow,
    ),
    true,
  );
});

/** A context whose sync service records each push and may fail it. */
function pushCtx(
  fail?: Error,
): { ctx: ConnectionContext; pushes: { namespace?: string }[] } {
  const pushes: { namespace?: string }[] = [];
  const ctx = {
    ...makeCtx([], "none"),
    syncService: {
      pushChanged: (options: { namespace?: string }) => {
        pushes.push(options);
        return fail ? Promise.reject(fail) : Promise.resolve();
      },
    },
  } as unknown as ConnectionContext;
  return { ctx, pushes };
}

Deno.test("pushChangedToRemote: pushes once, with no namespace for a filesystem datastore", async () => {
  const { ctx, pushes } = pushCtx();
  await pushChangedToRemote(ctx);
  assertEquals(pushes, [{ namespace: undefined }]);
});

Deno.test("pushChangedToRemote: does nothing without a sync service", async () => {
  await pushChangedToRemote(makeCtx([], "none"));
});

Deno.test("pushChangedToRemote: reports a failed push through onError and does not throw", async () => {
  const { ctx, pushes } = pushCtx(new Error("remote unavailable"));
  const reported: string[] = [];
  await pushChangedToRemote(ctx, { onError: (error) => reported.push(error) });
  assertEquals(pushes.length, 1);
  assertEquals(reported, ["remote unavailable"]);
});

Deno.test("pushChangedToRemote: a failed push without onError is logged, not thrown", async () => {
  const { ctx, pushes } = pushCtx(new Error("remote unavailable"));
  await pushChangedToRemote(ctx);
  assertEquals(pushes.length, 1);
});

Deno.test("isAuthorizedForAll: any deny that applies to the kind refuses, whatever its pattern", () => {
  const { socket, frames } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  const allowAll = makeGrant({ resource: { kind: "data", pattern: "*" } });
  const audited = (grants: Grant[]) => {
    const ctx = makeCtx(grants);
    const audit = withAuditLog(ctx);
    const allowed = isAuthorizedForAll(
      socket,
      "req-1",
      makePrincipal("adam"),
      "read",
      "data",
      ctx,
    );
    return { allowed, audit };
  };

  assertEquals(audited([allowAll]).allowed, true);
  const narrowDeny = audited([
    allowAll,
    makeGrant({
      effect: "deny",
      resource: { kind: "data", pattern: "prod-*" },
    }),
  ]);
  assertEquals(narrowDeny.allowed, false);
  assertEquals(narrowDeny.audit.length, 1);
  assertEquals(narrowDeny.audit[0].outcome, "denied");
  // A deny on another kind does not apply.
  assertEquals(
    audited([
      allowAll,
      makeGrant({
        effect: "deny",
        resource: { kind: "model", pattern: "prod-*" },
      }),
    ]).allowed,
    true,
  );
  assertEquals(frames, []);
});

// ── sanitizeErrorForClient logging (swamp-club#3465) ───────────────────────

async function captureWithheldErrors(fn: () => void): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["serve", "error"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    fn();
  } finally {
    await reset();
  }
  return records;
}

for (
  const [label, message] of [
    ["an absolute Unix path", "deno bundle failed for /tmp/abc/m.ts"],
    ["a .swamp path", "cannot read repo/.swamp/data/x/raw"],
    ["a Windows path", "cannot open C:\\Users\\me\\m.ts"],
  ]
) {
  Deno.test(`sanitizeErrorForClient: logs the original message it withholds for ${label}`, async () => {
    let result = "";
    const records = await captureWithheldErrors(() => {
      result = sanitizeErrorForClient(new Error(message));
    });

    assertEquals(result, "An internal error occurred");
    assertEquals(records.length, 1);
    assertEquals(records[0].level, "warning");
    assertEquals(records[0].properties.message, message);
    assertEquals(records[0].properties.type, "Error");
  });
}

Deno.test("sanitizeErrorForClient: logs the class name of a withheld custom error", async () => {
  class PermissionDenied extends Error {}
  const records = await captureWithheldErrors(() => {
    sanitizeErrorForClient(
      new PermissionDenied("Permission denied: readfile '/tmp/x/raw'"),
    );
  });

  assertEquals(records.length, 1);
  assertEquals(records[0].properties.type, "PermissionDenied");
});

Deno.test("sanitizeErrorForClient: logs a withheld non-Error value with its typeof", async () => {
  const records = await captureWithheldErrors(() => {
    sanitizeErrorForClient("failed at /home/user/file");
  });

  assertEquals(records.length, 1);
  assertEquals(records[0].properties.type, "string");
  assertEquals(records[0].properties.message, "failed at /home/user/file");
});

Deno.test("sanitizeErrorForClient: logs nothing for a message the client receives", async () => {
  const long = "x".repeat(600);
  let truncated = "";
  const records = await captureWithheldErrors(() => {
    sanitizeErrorForClient(new Error("Model not found: my-model"));
    truncated = sanitizeErrorForClient(new Error(long));
  });

  assertEquals(truncated, "x".repeat(512) + "...");
  assertEquals(records, []);
});

// ── Confirming write requests (swamp-club#3489) ─────────────────────────

/** A socket recording the JSON frames sent to it. */
function messageSocket(): { socket: WebSocket; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(JSON.parse(data)),
  } as unknown as WebSocket;
  return { socket, sent };
}

/** A confirmation the test settles by hand, counting calls. */
function manualConfirm() {
  const calls: PromiseWithResolvers<void>[] = [];
  return {
    calls,
    confirmReplicated: () => {
      const call = Promise.withResolvers<void>();
      calls.push(call);
      return call.promise;
    },
  };
}

Deno.test("confirmRequest: holds a success reply until the confirmation resolves", async () => {
  const { socket, sent } = messageSocket();
  const confirm = manualConfirm();
  const done = confirmRequest(confirm, socket, "r1", () => {
    send(socket, { type: "done", id: "r1" });
    return Promise.resolve();
  });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(sent, []);
  assertEquals(confirm.calls.length, 1);
  confirm.calls[0].resolve();
  await done;
  assertEquals(sent, [{ type: "done", id: "r1" }]);
});

Deno.test("confirmRequest: run events pass while the reply is held", async () => {
  const { socket, sent } = messageSocket();
  const confirm = manualConfirm();
  const event = {
    type: "event",
    id: "r1",
    event: { kind: "x" },
  } as unknown as ServerMessage;
  const done = confirmRequest(confirm, socket, "r1", () => {
    send(socket, event);
    send(socket, { type: "done", id: "r1" });
    return Promise.resolve();
  });
  assertEquals(sent.length, 1);
  await Promise.resolve();
  await Promise.resolve();
  confirm.calls[0].resolve();
  await done;
  assertEquals(sent.map((m) => m.type), ["event", "done"]);
});

Deno.test("confirmRequest: replaces the held success with the replication error", async () => {
  const { socket, sent } = messageSocket();
  const done = confirmRequest(
    {
      confirmReplicated: () =>
        Promise.reject(new V3ReplicationError("the sidecar timed out")),
    },
    socket,
    "r1",
    () => {
      send(socket, { type: "done", id: "r1" });
      return Promise.resolve();
    },
  );
  await done;
  assertEquals(sent.length, 1);
  const [reply] = sent;
  assertEquals(reply.type, "error");
  assertEquals(
    (reply as { error: { code: string } }).error.code,
    "datastore_v3_replication_unconfirmed",
  );
  // The handler's later reply for the request is dropped.
  send(socket, { type: "done", id: "r1" });
  assertEquals(sent.length, 1);
});

Deno.test("confirmRequest: a commit that fails after a held success sends exactly one error", async () => {
  const { socket, sent } = messageSocket();
  const confirm = manualConfirm();
  await assertRejects(() =>
    confirmRequest(confirm, socket, "r1", () => {
      send(socket, { type: "done", id: "r1" });
      return Promise.reject(new WriterFencedError(3, 4, "published"));
    })
  );
  assertEquals(confirm.calls.length, 0);
  assertEquals(sent.length, 1);
  assertEquals(
    (sent[0] as { error: { code: string } }).error.code,
    "datastore_v3_writer_fenced",
  );
});

Deno.test("confirmRequest: an error reply goes out without waiting for a confirmation", async () => {
  const { socket, sent } = messageSocket();
  const confirm = manualConfirm();
  await confirmRequest(confirm, socket, "r1", () => {
    sendError(socket, "r1", "not_found", "Data not found");
    return Promise.resolve();
  });
  assertEquals(confirm.calls.length, 0);
  assertEquals(sent.map((m) => m.type), ["error"]);
});

Deno.test("confirmRequest: without confirmReplicated nothing is held and nothing waits", async () => {
  const { socket, sent } = messageSocket();
  let ran = false;
  const done = confirmRequest({}, socket, "r1", () => {
    send(socket, { type: "done", id: "r1" });
    ran = true;
    return Promise.resolve();
  });
  // Sent synchronously, as without the wrapper.
  assertEquals(ran, true);
  assertEquals(sent, [{ type: "done", id: "r1" }]);
  await done;
});

Deno.test("confirmRequest: holds only the request it wraps", async () => {
  const { socket, sent } = messageSocket();
  const confirm = manualConfirm();
  const done = confirmRequest(confirm, socket, "r1", () => {
    send(socket, { type: "done", id: "r2" });
    return Promise.resolve();
  });
  assertEquals(sent, [{ type: "done", id: "r2" }]);
  await Promise.resolve();
  await Promise.resolve();
  confirm.calls[0].resolve();
  await done;
});

Deno.test("confirmRunReplicated: resolves undefined when confirmed or when nothing confirms", async () => {
  assertEquals(await confirmRunReplicated({}, "x_failed"), undefined);
  assertEquals(
    await confirmRunReplicated(
      { confirmReplicated: () => Promise.resolve() },
      "x_failed",
    ),
    undefined,
  );
});

Deno.test("confirmRunReplicated: returns the terminal error a failed confirmation reports", async () => {
  const result = await confirmRunReplicated(
    {
      confirmReplicated: () =>
        Promise.reject(new V3ReplicationError("the sidecar timed out")),
    },
    "workflow_execution_failed",
  );
  assertEquals(result?.code, "datastore_v3_replication_unconfirmed");
});

Deno.test("replicationErrorForClient: keeps the replication codes and falls back otherwise", () => {
  assertEquals(
    replicationErrorForClient(new WriterFencedError(1, 2, "published"), "f")
      .code,
    "datastore_v3_writer_fenced",
  );
  assertEquals(
    replicationErrorForClient(new V3ReplicationError("x"), "f").code,
    "datastore_v3_replication_unconfirmed",
  );
  assertEquals(replicationErrorForClient(new Error("boom"), "f").code, "f");
});

Deno.test("confirmRequest: a request during which nothing committed is not confirmed", async () => {
  const { socket, sent } = messageSocket();
  const confirm = manualConfirm();
  let mark = 4;
  const ctx = { ...confirm, replicationMark: () => mark };
  await confirmRequest(ctx, socket, "r1", () => {
    send(socket, { type: "done", id: "r1" });
    return Promise.resolve();
  });
  assertEquals(confirm.calls.length, 0);
  assertEquals(sent, [{ type: "done", id: "r1" }]);
  const done = confirmRequest(ctx, socket, "r2", () => {
    mark = 5;
    send(socket, { type: "done", id: "r2" });
    return Promise.resolve();
  });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(confirm.calls.length, 1);
  confirm.calls[0].resolve();
  await done;
  assertEquals(sent.length, 2);
});

// --- authorizeRetag (swamp-club#3085) ---

/** A context where `write` does not imply `tag`, as with the flag on. */
function explicitTagCtx(grants: Grant[]): ConnectionContext {
  return {
    ...makeCtx(grants),
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
        { writeImpliesTag: false },
      ),
    } as unknown as PolicySnapshotLoader,
  };
}

function modelWithTags(tags: Record<string, string>) {
  return {
    kind: "model" as const,
    name: "other-model",
    fields: { name: "other-model", modelType: "command/shell", tags },
  };
}

/** Write on every model, and tag only on team-a models. */
const teamATagGrants = [
  makeGrant({ actions: ["write"] }),
  makeGrant({ actions: ["tag"], condition: 'tags.team == "team-a"' }),
];

function retag(
  ctx: ConnectionContext,
  tags: {
    loaded: Record<string, string>;
    stored: Record<string, string> | null;
    afterTags: Record<string, string>;
  },
): { allowed: boolean; frames: string[] } {
  const { socket, frames } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  const allowed = authorizeRetag(socket, "req-retag", makePrincipal("adam"), {
    prior: modelWithTags,
    after: modelWithTags(tags.afterTags),
    ...tags,
  }, ctx);
  return { allowed, frames };
}

Deno.test("authorizeRetag: an edit that changes no tags needs no tag grant", () => {
  const tags = { team: "team-b" };
  const result = retag(explicitTagCtx([makeGrant({ actions: ["write"] })]), {
    loaded: tags,
    stored: { ...tags },
    afterTags: { ...tags },
  });
  assertEquals(result, { allowed: true, frames: [] });
});

Deno.test("authorizeRetag: moving a resource into a tag needs tag on its prior tags", () => {
  const result = retag(explicitTagCtx(teamATagGrants), {
    loaded: { team: "team-b" },
    stored: { team: "team-b" },
    afterTags: { team: "team-a" },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.frames.length, 1);
  assertEquals(JSON.parse(result.frames[0]).type, "error");
});

Deno.test("authorizeRetag: moving a resource out of a tag needs tag on its new tags", () => {
  const result = retag(explicitTagCtx(teamATagGrants), {
    loaded: { team: "team-a" },
    stored: { team: "team-a" },
    afterTags: { team: "team-b" },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.frames.length, 1);
});

Deno.test("authorizeRetag: a retag within a granted tag is allowed", () => {
  const result = retag(explicitTagCtx(teamATagGrants), {
    loaded: { team: "team-a" },
    stored: { team: "team-a" },
    afterTags: { team: "team-a", env: "prod" },
  });
  assertEquals(result, { allowed: true, frames: [] });
});

Deno.test("authorizeRetag: an edit carrying the loaded tags cannot undo a retag stored since", () => {
  // The edit loaded team-a and writes team-a back, but team-b is stored now.
  const result = retag(explicitTagCtx(teamATagGrants), {
    loaded: { team: "team-a" },
    stored: { team: "team-b" },
    afterTags: { team: "team-a" },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.frames.length, 1);
});

Deno.test("authorizeRetag: a resource no longer stored as loaded is judged a retag", () => {
  const tags = { team: "team-b" };
  const refused = retag(explicitTagCtx([makeGrant({ actions: ["write"] })]), {
    loaded: tags,
    stored: null,
    afterTags: { ...tags },
  });
  assertEquals(refused.allowed, false);
  const allowed = retag(
    explicitTagCtx([makeGrant({ actions: ["write", "tag"] })]),
    { loaded: tags, stored: null, afterTags: { ...tags } },
  );
  assertEquals(allowed, { allowed: true, frames: [] });
});

Deno.test("authorizeRetag: write implies tag unless the server requires an explicit grant", () => {
  const result = retag(makeCtx([makeGrant({ actions: ["write"] })]), {
    loaded: { team: "team-b" },
    stored: { team: "team-b" },
    afterTags: { team: "team-a" },
  });
  assertEquals(result, { allowed: true, frames: [] });
});

function namedModel(name: string, tags: Record<string, string>) {
  return {
    kind: "model" as const,
    name,
    fields: { name, modelType: "command/shell", tags },
  };
}

function rename(
  ctx: ConnectionContext,
  names: { from: string; to: string },
  tags: Record<string, string>,
): boolean {
  const { socket } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  return authorizeRetag(socket, "req-rename", makePrincipal("adam"), {
    prior: (prior) => namedModel(names.from, prior),
    after: namedModel(names.to, { ...tags }),
    loaded: tags,
    stored: { ...tags },
    afterTags: { ...tags },
  }, ctx);
}

Deno.test("authorizeRetag: a rename needs tag on the old and new name, so a name-scoped tag grant cannot be reached by renaming first", () => {
  const nameScoped = explicitTagCtx([
    makeGrant({ actions: ["write"] }),
    makeGrant({
      actions: ["tag"],
      resource: { kind: "model", pattern: "team-a-*" },
    }),
  ]);
  const tags = { team: "team-b" };

  assertEquals(
    rename(nameScoped, { from: "other-model", to: "team-a-loot" }, tags),
    false,
  );
  assertEquals(
    rename(nameScoped, { from: "team-a-old", to: "team-a-new" }, tags),
    true,
  );
});

Deno.test("authorizeRetag: by default a rename passes on the tag write implies", () => {
  assertEquals(
    rename(
      makeCtx([makeGrant({ actions: ["write"] })]),
      { from: "other-model", to: "team-a-loot" },
      { team: "team-b" },
    ),
    true,
  );
});

// ── Request span outcome (swamp-club#3741) ──────────────────────────────

Deno.test("isServerFailureCode: internal errors and operation failures are server failures", () => {
  assertEquals(isServerFailureCode("internal_error"), true);
  assertEquals(isServerFailureCode("workflow_history_get_failed"), true);
});

Deno.test("isServerFailureCode: client errors are not server failures", () => {
  assertEquals(isServerFailureCode("validation_failed"), false);
  assertEquals(isServerFailureCode("not_found"), false);
  assertEquals(isServerFailureCode("forbidden"), false);
  assertEquals(isServerFailureCode("cancelled"), false);
});

Deno.test("sendError: records a client error code on the active span without marking it ERROR", async () => {
  await withCapturedSpans(async (spans) => {
    const { socket, sent } = messageSocket();
    await withServerSpan("test.request", {}, () => {
      sendError(socket, "r1", "not_found", "Data not found");
      return Promise.resolve();
    });

    const span = findSpan(spans, "test.request");
    assertEquals(
      span.attributes["swamp.serve.response.error_code"],
      "not_found",
    );
    assertEquals(span.status.code, SpanStatusCode.UNSET);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
  });
});

Deno.test("sendError: marks the active span ERROR for a server failure code", async () => {
  await withCapturedSpans(async (spans) => {
    const { socket } = messageSocket();
    await withServerSpan("test.request", {}, () => {
      sendError(socket, "r1", "workflow_history_get_failed", "boom");
      return Promise.resolve();
    });

    const span = findSpan(spans, "test.request");
    assertEquals(
      span.attributes["swamp.serve.response.error_code"],
      "workflow_history_get_failed",
    );
    assertEquals(span.status.code, SpanStatusCode.ERROR);
    assertEquals(span.status.message, "workflow_history_get_failed");
    assertEquals(
      span.attributes["swamp.serve.response.error_reason"],
      undefined,
    );
  });
});

Deno.test("sendError: an operation failure whose details name a client reason records the reason without marking ERROR", async () => {
  await withCapturedSpans(async (spans) => {
    const { socket, sent } = messageSocket();
    await withServerSpan("test.request", {}, () => {
      sendError(
        socket,
        "r1",
        "workflow_history_get_failed",
        "Workflow run not found",
        { reason: "not_found" },
      );
      return Promise.resolve();
    });

    const span = findSpan(spans, "test.request");
    assertEquals(
      span.attributes["swamp.serve.response.error_code"],
      "workflow_history_get_failed",
    );
    assertEquals(
      span.attributes["swamp.serve.response.error_reason"],
      "not_found",
    );
    assertEquals(span.status.code, SpanStatusCode.UNSET);
    assertEquals(sent.length, 1);
  });
});

Deno.test("sendError: details naming an unknown reason still mark a server failure ERROR", async () => {
  await withCapturedSpans(async (spans) => {
    const { socket } = messageSocket();
    await withServerSpan("test.request", {}, () => {
      sendError(socket, "r1", "workflow_history_get_failed", "boom", {
        reason: "disk_on_fire",
      });
      return Promise.resolve();
    });

    const span = findSpan(spans, "test.request");
    assertEquals(
      span.attributes["swamp.serve.response.error_reason"],
      undefined,
    );
    assertEquals(span.status.code, SpanStatusCode.ERROR);
  });
});

Deno.test("sendError: sends the error frame when no span is active", () => {
  const { socket, sent } = messageSocket();
  sendError(socket, "r1", "internal_error", "boom");
  assertEquals(sent.length, 1);
  assertEquals(sent[0].type, "error");
});

Deno.test("sendTraced: sends the message inside a swamp.serve.response.send child span", async () => {
  await withCapturedSpans(async (spans) => {
    const { socket, sent } = messageSocket();
    await withServerSpan(
      "test.request",
      {},
      () => sendTraced(socket, { type: "done", id: "r1" }),
    );

    assertEquals(sent, [{ type: "done", id: "r1" }]);
    const request = findSpan(spans, "test.request");
    const sendSpan = findSpan(spans, "swamp.serve.response.send");
    assertEquals(isChildOf(sendSpan, request), true);
  });
});

// ── Replies after a v3 root's commit (swamp-club#3759) ─────────────────

/** A run event frame of `kind` for request `id`. */
function runEvent(kind: string, id = "r1"): ServerMessage {
  return { type: "event", id, event: { kind } } as unknown as ServerMessage;
}

Deno.test("confirmRequest: on v3 without replication, replies wait for the handler and no confirmation runs (swamp-club#3759)", async () => {
  const { socket, sent } = messageSocket();
  const handler = Promise.withResolvers<void>();
  const done = confirmRequest(
    { holdRepliesUntilCommitted: true },
    socket,
    "r1",
    () => {
      send(socket, runEvent("executing"));
      send(socket, runEvent("completed"));
      send(socket, { type: "done", id: "r1" });
      return handler.promise;
    },
  );
  assertEquals(
    sent.map((m) => m.type),
    ["event"],
    "progress streams, the outcome waits",
  );
  handler.resolve();
  await done;
  assertEquals(
    sent.map((m) =>
      m.type === "event"
        ? `event:${(m as { event: { kind: string } }).event.kind}`
        : m.type
    ),
    ["event:executing", "event:completed", "done"],
  );
});

Deno.test("confirmRequest: a run's outcome event, and every event after it, waits with the reply (swamp-club#3759)", async () => {
  const { socket, sent } = messageSocket();
  const confirm = manualConfirm();
  const done = confirmRequest(confirm, socket, "r1", () => {
    send(socket, runEvent("executing"));
    send(socket, runEvent("completed"));
    send(socket, runEvent("auto_gc_completed"));
    send(socket, { type: "done", id: "r1" });
    return Promise.resolve();
  });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(sent.length, 1);
  confirm.calls[0].resolve();
  await done;
  assertEquals(sent.map((m) => m.type), ["event", "event", "event", "done"]);
});

Deno.test("confirmRequest: a commit that fails drops the held outcome event and done, and sends only the error (swamp-club#3759)", async () => {
  const { socket, sent } = messageSocket();
  await assertRejects(() =>
    confirmRequest({ holdRepliesUntilCommitted: true }, socket, "r1", () => {
      send(socket, runEvent("completed"));
      send(socket, { type: "done", id: "r1" });
      return Promise.reject(
        new CommitUnreachableError(new Error("connect ECONNREFUSED")),
      );
    })
  );
  assertEquals(sent.map((m) => m.type), ["error"]);
  assertEquals(
    (sent[0] as { error: { code: string } }).error.code,
    COMMIT_UNREACHABLE_CODE,
  );
});

Deno.test("confirmRequest: a handler that answers its commit failure with an error drops the held outcome and done (swamp-club#3759)", async () => {
  const { socket, sent } = messageSocket();
  await confirmRequest(
    { holdRepliesUntilCommitted: true },
    socket,
    "r1",
    () => {
      send(socket, runEvent("completed"));
      send(socket, { type: "done", id: "r1" });
      sendError(socket, "r1", "method_execution_failed", "commit failed");
      return Promise.resolve();
    },
  );
  assertEquals(sent.map((m) => m.type), ["error"]);
});

Deno.test("runFailureForClient: a commit that could not reach the storage keeps its code, worded for a run; anything else is the fallback (swamp-club#3759)", () => {
  const unreachable = runFailureForClient(
    new CommitUnreachableError(new Error("connect ECONNREFUSED")),
    "method_execution_failed",
  );
  assertEquals(unreachable.code, COMMIT_UNREACHABLE_CODE);
  assertStringIncludes(unreachable.message, "steps had already run");
  assertEquals(
    runFailureForClient(new Error("boom"), "method_execution_failed").code,
    "method_execution_failed",
  );
});

Deno.test("runFailureForClient: a run a checkpoint partly committed keeps its code, worded for a run whose steps ran (swamp-club#3802)", () => {
  const partly = runFailureForClient(
    new RunPartlyCommittedError(new Error("connect ECONNREFUSED"), [
      { workflowId: "wf-1", runId: "run-1" },
    ]),
    "workflow_execution_failed",
  );
  assertEquals(partly.code, RUN_PARTLY_COMMITTED_CODE);
  assertStringIncludes(partly.message, "steps had already run");
  assertStringIncludes(partly.message, "swamp workflow recover wf-1");
});

Deno.test("withCommittedUnknownSteps: a served run cut while its step ran names the step and a recover command with --acknowledge-unknown; any other error is unchanged (swamp-club#3882)", () => {
  const checkpointer = {
    committedUnknownSteps: (runId: string) =>
      runId === "run-1" ? ["deploy"] : undefined,
  };
  const worded = withCommittedUnknownSteps(
    new RunPartlyCommittedError(new Error("connect ECONNREFUSED"), [
      { workflowId: "wf-1", runId: "run-1" },
      { workflowId: "wf-2", runId: "run-2" },
    ]),
    checkpointer,
  );
  assertInstanceOf(worded, RunPartlyCommittedError);
  assertEquals(worded.runs, [
    { workflowId: "wf-1", runId: "run-1", unknownSteps: ["deploy"] },
    { workflowId: "wf-2", runId: "run-2" },
  ]);
  assertStringIncludes(
    worded.message,
    "swamp workflow recover wf-1 --run run-1 --acknowledge-unknown; " +
      "swamp workflow recover wf-2 --run run-2 in",
  );
  const reply = runFailureForClient(worded, "workflow_execution_failed");
  assertEquals(reply.code, RUN_PARTLY_COMMITTED_CODE);
  assertStringIncludes(
    reply.message,
    "swamp workflow recover wf-1 --run run-1 --acknowledge-unknown",
  );
  const other = new Error("other");
  assertStrictEquals(withCommittedUnknownSteps(other, checkpointer), other);
});

Deno.test("runFailureForClient: a commit part of which had landed keeps its own code (swamp-club#3802)", () => {
  const partly = runFailureForClient(
    new CommitUnreachableError(new Error("connect ECONNREFUSED"), {
      partly: true,
    }),
    "method_execution_failed",
  );
  assertEquals(partly.code, COMMIT_PARTLY_COMMITTED_CODE);
  assertStringIncludes(partly.message, "steps had already run");
});

Deno.test("runFailureForClient: preserves secret refusal codes for direct, wrapped and transported failures", () => {
  for (
    const code of [
      "secret_operation_unsupported",
      "secret_destination_refused",
      "secret_reference_invalid",
    ]
  ) {
    const cause = new UserError("Refused a secret", code);
    for (
      const error of [cause, new Error("wrapper", { cause }), {
        code,
        message: cause.message,
      }]
    ) {
      assertEquals(
        runFailureForClient(error, "method_execution_failed").code,
        code,
      );
    }
  }
  assertEquals(
    runFailureForClient(
      new UserError("other", "other_code"),
      "method_execution_failed",
    ).code,
    "method_execution_failed",
  );
});
