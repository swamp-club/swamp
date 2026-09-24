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

import { assertEquals, assertRejects } from "@std/assert";
import {
  authenticateServerToken,
  classifyRedeemError,
  extractWebSocketToken,
  readServerTokenRecord,
  type ServerTokenAuthDeps,
  splitServerToken,
} from "./token_auth.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { ServerToken } from "../domain/models/access/server_token_model.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";

// ── splitServerToken ────────────────────────────────────────────────────

Deno.test("splitServerToken: splits valid name.secret", () => {
  const result = splitServerToken("adam-token.abc123def456");
  assertEquals(result, { name: "adam-token", secret: "abc123def456" });
});

Deno.test("splitServerToken: returns null for no dot", () => {
  assertEquals(splitServerToken("no-dot-here"), null);
});

Deno.test("splitServerToken: returns null for leading dot", () => {
  assertEquals(splitServerToken(".leading-dot"), null);
});

Deno.test("splitServerToken: returns null for trailing dot", () => {
  assertEquals(splitServerToken("trailing-dot."), null);
});

Deno.test("splitServerToken: handles dots in secret", () => {
  const result = splitServerToken("my-token.secret.with.dots");
  assertEquals(result, { name: "my-token", secret: "secret.with.dots" });
});

Deno.test("splitServerToken: single-char name and secret", () => {
  const result = splitServerToken("a.b");
  assertEquals(result, { name: "a", secret: "b" });
});

// ── extractWebSocketToken ──────────────────────────────────────────────

function makeReq(
  url: string,
  headers?: Record<string, string>,
): Request {
  return new Request(url, { headers });
}

Deno.test("extractWebSocketToken: extracts from Authorization Bearer header", () => {
  const req = makeReq("http://localhost:4000/", {
    "authorization": "Bearer mytoken.secret123",
  });
  const result = extractWebSocketToken(req);
  assertEquals(result, { token: "mytoken.secret123", transport: "bearer" });
});

Deno.test("extractWebSocketToken: extracts from Sec-WebSocket-Protocol bearer.*", () => {
  const req = makeReq("http://localhost:4000/", {
    "sec-websocket-protocol": "bearer.mytoken.secret123",
  });
  const result = extractWebSocketToken(req);
  assertEquals(result, {
    token: "mytoken.secret123",
    transport: "subprotocol",
  });
});

Deno.test("extractWebSocketToken: Bearer scheme is case-insensitive", () => {
  const lower = makeReq("http://localhost:4000/", {
    "authorization": "bearer mytoken.secret123",
  });
  assertEquals(extractWebSocketToken(lower), {
    token: "mytoken.secret123",
    transport: "bearer",
  });

  const upper = makeReq("http://localhost:4000/", {
    "authorization": "BEARER mytoken.secret123",
  });
  assertEquals(extractWebSocketToken(upper), {
    token: "mytoken.secret123",
    transport: "bearer",
  });
});

Deno.test("extractWebSocketToken: extracts from query parameter", () => {
  const req = makeReq("http://localhost:4000/?token=mytoken.secret123");
  const result = extractWebSocketToken(req);
  assertEquals(result, { token: "mytoken.secret123", transport: "query" });
});

Deno.test("extractWebSocketToken: returns null when no token present", () => {
  const req = makeReq("http://localhost:4000/");
  assertEquals(extractWebSocketToken(req), null);
});

Deno.test("extractWebSocketToken: Bearer takes priority over query param", () => {
  const req = makeReq("http://localhost:4000/?token=query.token", {
    "authorization": "Bearer header.token",
  });
  const result = extractWebSocketToken(req);
  assertEquals(result, { token: "header.token", transport: "bearer" });
});

Deno.test("extractWebSocketToken: Bearer takes priority over subprotocol", () => {
  const req = makeReq("http://localhost:4000/", {
    "authorization": "Bearer header.token",
    "sec-websocket-protocol": "bearer.sub.token",
  });
  const result = extractWebSocketToken(req);
  assertEquals(result, { token: "header.token", transport: "bearer" });
});

Deno.test("extractWebSocketToken: subprotocol takes priority over query param", () => {
  const req = makeReq("http://localhost:4000/?token=query.token", {
    "sec-websocket-protocol": "bearer.sub.token",
  });
  const result = extractWebSocketToken(req);
  assertEquals(result, { token: "sub.token", transport: "subprotocol" });
});

Deno.test("extractWebSocketToken: ignores malformed Bearer (no token after prefix)", () => {
  const req = makeReq("http://localhost:4000/", {
    "authorization": "Bearer ",
  });
  assertEquals(extractWebSocketToken(req), null);
});

Deno.test("extractWebSocketToken: ignores non-Bearer authorization header", () => {
  const req = makeReq("http://localhost:4000/", {
    "authorization": "Basic dXNlcjpwYXNz",
  });
  assertEquals(extractWebSocketToken(req), null);
});

Deno.test("extractWebSocketToken: ignores subprotocol without bearer. prefix", () => {
  const req = makeReq("http://localhost:4000/", {
    "sec-websocket-protocol": "graphql-ws, other-protocol",
  });
  assertEquals(extractWebSocketToken(req), null);
});

Deno.test("extractWebSocketToken: finds bearer.* among multiple subprotocols", () => {
  const req = makeReq("http://localhost:4000/", {
    "sec-websocket-protocol": "graphql-ws, bearer.mytoken.secret, other",
  });
  const result = extractWebSocketToken(req);
  assertEquals(result, { token: "mytoken.secret", transport: "subprotocol" });
});

Deno.test("extractWebSocketToken: ignores empty bearer. subprotocol", () => {
  const req = makeReq("http://localhost:4000/", {
    "sec-websocket-protocol": "bearer.",
  });
  assertEquals(extractWebSocketToken(req), null);
});

Deno.test("extractWebSocketToken: ignores empty query param", () => {
  const req = makeReq("http://localhost:4000/?token=");
  assertEquals(extractWebSocketToken(req), null);
});

// ── classifyRedeemError ────────────────────────────────────────────────

Deno.test("classifyRedeemError: classifies expired token", () => {
  assertEquals(
    classifyRedeemError("Server token 'bot' has expired"),
    "expired",
  );
});

Deno.test("classifyRedeemError: classifies revoked token", () => {
  assertEquals(
    classifyRedeemError("Server token 'bot' has been revoked"),
    "revoked",
  );
});

Deno.test("classifyRedeemError: classifies secret mismatch", () => {
  assertEquals(
    classifyRedeemError("Server token 'bot' does not match"),
    "secret-mismatch",
  );
});

Deno.test("classifyRedeemError: classifies no definition", () => {
  assertEquals(
    classifyRedeemError("Server token 'bot' does not exist — mint it first"),
    "no-definition",
  );
});

Deno.test("classifyRedeemError: classifies invalid format", () => {
  assertEquals(
    classifyRedeemError("Invalid token format: expected <name>.<secret>"),
    "invalid-format",
  );
});

Deno.test("classifyRedeemError: classifies vault error", () => {
  assertEquals(
    classifyRedeemError(
      "Secret 'server-token-bot' not found in _token-secrets",
    ),
    "vault-error",
  );
  assertEquals(
    classifyRedeemError("Vault 'my-vault' not found"),
    "vault-error",
  );
});

Deno.test("classifyRedeemError: returns unknown for unrecognized errors", () => {
  assertEquals(
    classifyRedeemError("Something completely unexpected"),
    "unknown",
  );
});

// ── authenticateServerToken ─────────────────────────────────────────────

function activeToken(overrides: Partial<ServerToken> = {}): ServerToken {
  return {
    name: "test-token",
    state: "active",
    principalId: "user:test-user",
    principalEmail: "test@example.com",
    collectives: ["engineering"],
    groups: ["developers"],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    vaultName: "token-vault",
    secretKey: "server-token-test-token",
    ...overrides,
  };
}

function makeAuthDeps(
  overrides: Partial<ServerTokenAuthDeps> = {},
): ServerTokenAuthDeps {
  return {
    readToken: () => Promise.resolve(activeToken()),
    readSecret: () => Promise.resolve("secret-value"),
    ...overrides,
  };
}

const unusedRepoContext = {} as RepositoryContext;

function authenticateWithDeps(
  token: string,
  deps: ServerTokenAuthDeps,
  events?: AuditEvent[],
) {
  return authenticateServerToken(
    token,
    "/tmp/nonexistent",
    unusedRepoContext,
    events
      ? {
        emitter: { emit: (event) => events.push(event) },
        instanceId: "instance-1",
        sourceIp: "192.0.2.1",
        requestId: "request-1",
        ingress: "websocket:bearer",
      }
      : undefined,
    deps,
  );
}

Deno.test("authenticateServerToken: reads and validates a token without a model run", async () => {
  const result = await authenticateWithDeps(
    "test-token.secret-value",
    makeAuthDeps(),
  );

  assertEquals(result, {
    ok: true,
    principalId: "user:test-user",
    collectives: ["engineering"],
    groups: ["developers"],
    tokenName: "test-token",
    tokenCreatedAt: "2026-01-01T00:00:00.000Z",
  });
});

Deno.test("authenticateServerToken: reports the createdAt of the mint that authenticated", async () => {
  const result = await authenticateWithDeps(
    "test-token.secret-value",
    makeAuthDeps({
      readToken: () =>
        Promise.resolve(
          activeToken({ createdAt: "2026-05-05T05:05:05.000Z" }),
        ),
    }),
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.tokenName, "test-token");
  assertEquals(result.tokenCreatedAt, "2026-05-05T05:05:05.000Z");
});

// ── readServerTokenRecord ───────────────────────────────────────────────

function fakeTokenRepoContext(
  definition: { id: string } | null,
  content: Uint8Array | null,
): RepositoryContext {
  return {
    definitionRepo: { findByName: () => Promise.resolve(definition) },
    unifiedDataRepo: { getContent: () => Promise.resolve(content) },
  } as unknown as RepositoryContext;
}

Deno.test("readServerTokenRecord: parses the stored token record", async () => {
  const token = activeToken();
  const record = await readServerTokenRecord(
    fakeTokenRepoContext(
      { id: "def-1" },
      new TextEncoder().encode(JSON.stringify(token)),
    ),
    "test-token",
  );
  assertEquals(record, token);
});

Deno.test("readServerTokenRecord: a missing definition does not exist", async () => {
  await assertRejects(
    () => readServerTokenRecord(fakeTokenRepoContext(null, null), "gone"),
    Error,
    "does not exist",
  );
});

Deno.test("readServerTokenRecord: a missing record does not exist", async () => {
  await assertRejects(
    () =>
      readServerTokenRecord(
        fakeTokenRepoContext({ id: "def-1" }, null),
        "gone",
      ),
    Error,
    "does not exist",
  );
});

Deno.test("authenticateServerToken: applies the shared lifecycle validation", async () => {
  const result = await authenticateWithDeps(
    "test-token.secret-value",
    makeAuthDeps({
      readToken: () => Promise.resolve(activeToken({ state: "revoked" })),
    }),
  );

  assertEquals(result, {
    ok: false,
    error: "Authentication failed",
    reason: "revoked",
  });
});

Deno.test("authenticateServerToken: rejects a mismatched secret", async () => {
  const result = await authenticateWithDeps(
    "test-token.wrong-secret",
    makeAuthDeps(),
  );

  assertEquals(result, {
    ok: false,
    error: "Authentication failed",
    reason: "secret-mismatch",
  });
});

for (const principalId of ["agent:swamp-resumer", "adam", "user:"]) {
  Deno.test(`authenticateServerToken: rejects stored principal ${principalId} as invalid-principal without an audit event`, async () => {
    const events: AuditEvent[] = [];
    const result = await authenticateWithDeps(
      "test-token.secret-value",
      makeAuthDeps({
        readToken: () => Promise.resolve(activeToken({ principalId })),
      }),
      events,
    );

    assertEquals(result, {
      ok: false,
      error: "Authentication failed",
      reason: "invalid-principal",
    });
    assertEquals(events.length, 0);
  });
}

Deno.test("authenticateServerToken: checks the secret before the stored principal", async () => {
  const result = await authenticateWithDeps(
    "test-token.wrong-secret",
    makeAuthDeps({
      readToken: () =>
        Promise.resolve(activeToken({ principalId: "agent:swamp-resumer" })),
    }),
  );

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "secret-mismatch");
});

Deno.test("authenticateServerToken: accepts a worker principal", async () => {
  const result = await authenticateWithDeps(
    "test-token.secret-value",
    makeAuthDeps({
      readToken: () =>
        Promise.resolve(activeToken({ principalId: "worker:runner-1" })),
    }),
  );

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.principalId, "worker:runner-1");
});

Deno.test("authenticateServerToken: emits a secret-free audit event after successful ingress", async () => {
  const events: AuditEvent[] = [];
  const result = await authenticateWithDeps(
    "test-token.secret-value",
    makeAuthDeps(),
    events,
  );

  assertEquals(result.ok, true);
  assertEquals(events.length, 1);
  assertEquals(events[0].action, "auth.token.used");
  assertEquals(events[0].resourceName, "test-token");
  assertEquals(events[0].principalId, "user:test-user");
  assertEquals(events[0].sourceIp, "192.0.2.1");
  assertEquals(events[0].detail, "websocket:bearer");
  assertEquals(JSON.stringify(events[0]).includes("secret-value"), false);
});

Deno.test("authenticateServerToken: ignores audit-emitter errors", async () => {
  const result = await authenticateServerToken(
    "test-token.secret-value",
    "/tmp/nonexistent",
    unusedRepoContext,
    {
      emitter: {
        emit: () => {
          throw new Error("audit unavailable");
        },
      },
    },
    makeAuthDeps(),
  );

  assertEquals(result.ok, true);
});

Deno.test("authenticateServerToken: rejects token exceeding MAX_TOKEN_LENGTH", async () => {
  const longToken = "name." + "a".repeat(513);
  const result = await authenticateServerToken(
    longToken,
    "/tmp/nonexistent",
    {} as RepositoryContext,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, "Token exceeds maximum length");
    assertEquals(result.reason, "invalid-format");
  }
});
