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
  authenticateServerToken,
  extractWebSocketToken,
  splitServerToken,
} from "./token_auth.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";

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

// ── authenticateServerToken ─────────────────────────────────────────────

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
  }
});
