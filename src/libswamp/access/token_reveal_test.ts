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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  serverTokenReveal,
  type ServerTokenRevealDeps,
  type ServerTokenRevealEvent,
} from "./token_reveal.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";

function tokenRecord(
  name: string,
  overrides?: Partial<Record<string, unknown>>,
): DataRecord {
  return {
    id: `data-${name}`,
    name: "token-main",
    modelId: name,
    modelName: name,
    modelType: "swamp/server-token",
    attributes: {
      name,
      state: "active",
      principalId: "user:adam",
      principalEmail: "adam@example.com",
      createdAt: "2026-06-18T00:00:00.000Z",
      expiresAt: "2026-12-18T00:00:00.000Z",
      vaultName: "_token-secrets",
      secretKey: `server-token-${name}`,
      ...overrides,
    },
  } as unknown as DataRecord;
}

function makeDeps(
  overrides?: Partial<ServerTokenRevealDeps>,
): ServerTokenRevealDeps {
  return {
    query: () => Promise.resolve([tokenRecord("test-token")]),
    readSecret: () => Promise.resolve("abc123secret"),
    ...overrides,
  };
}

Deno.test("serverTokenReveal: reveals the full token credential", async () => {
  const events = await collect<ServerTokenRevealEvent>(
    serverTokenReveal(createLibSwampContext(), makeDeps(), "test-token"),
  );

  assertEquals(events[0], { kind: "resolving", name: "test-token" });
  const completed = events[1] as Extract<
    ServerTokenRevealEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data, {
    name: "test-token",
    token: "test-token.abc123secret",
    expired: false,
    vaultRef: {
      vaultName: "_token-secrets",
      secretKey: "server-token-test-token",
    },
  });
});

Deno.test("serverTokenReveal: errors when token does not exist", async () => {
  const deps = makeDeps({ query: () => Promise.resolve([]) });
  const events = await collect<ServerTokenRevealEvent>(
    serverTokenReveal(createLibSwampContext(), deps, "missing"),
  );
  const error = events[1] as Extract<
    ServerTokenRevealEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "token_not_found");
  assertStringIncludes(error.error.message, "'missing'");
});

Deno.test("serverTokenReveal: errors when token is revoked", async () => {
  const deps = makeDeps({
    query: () =>
      Promise.resolve([tokenRecord("revoked-token", { state: "revoked" })]),
  });
  const events = await collect<ServerTokenRevealEvent>(
    serverTokenReveal(createLibSwampContext(), deps, "revoked-token"),
  );
  const error = events[1] as Extract<
    ServerTokenRevealEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "token_revoked");
  assertStringIncludes(error.error.message, "'revoked-token'");
});

Deno.test("serverTokenReveal: errors when vault read fails", async () => {
  const deps = makeDeps({
    readSecret: () => Promise.reject(new Error("vault provider unavailable")),
  });
  const events = await collect<ServerTokenRevealEvent>(
    serverTokenReveal(createLibSwampContext(), deps, "test-token"),
  );
  const error = events[1] as Extract<
    ServerTokenRevealEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "vault_read_failed");
  assertStringIncludes(error.error.message, "vault provider unavailable");
});

Deno.test("serverTokenReveal: errors when query fails", async () => {
  const deps = makeDeps({
    query: () => Promise.reject(new Error("datastore unreachable")),
  });
  const events = await collect<ServerTokenRevealEvent>(
    serverTokenReveal(createLibSwampContext(), deps, "test-token"),
  );
  const error = events[1] as Extract<
    ServerTokenRevealEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "token_query_failed");
  assertStringIncludes(error.error.message, "datastore unreachable");
});
